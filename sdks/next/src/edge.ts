import { redactBody, redactHeaders, safeUrlParts } from './redaction';
import type { CapturedBody, ServerCall } from './types';

/**
 * Edge middleware capture, `@apilens/next-sdk/edge`.
 *
 * Next 14 runs `middleware.ts` in its Edge sandbox, with its own `fetch` and
 * no Node `http`, so the Node hooks of the main entry never see the calls it
 * makes: session lookups, journey bootstrap, account checks. This entry wraps
 * the middleware function instead, records those calls inside the sandbox and
 * posts them to the app's own control plane (`/api/__apilens/ingest`), where
 * they appear next to the page and route calls in the extension.
 *
 * It imports nothing from Node, so it is safe to bundle into Edge code.
 */

export interface EdgeCaptureOptions {
  /** Explicit opt-in, normally `process.env.APILENS_ENABLED === 'true'`. Default false. */
  enabled?: boolean;
  serviceName?: string;
  /** The same APILENS_CONTROL_TOKEN the Node SDK uses; at least 24 characters. */
  controlToken?: string;
  /**
   * Control endpoint to deliver to. Default `<request origin>/api/__apilens`.
   * Behind a load balancer, point it at the pod itself, for example
   * `http://127.0.0.1:${process.env.PORT}/api/__apilens`.
   */
  ingestUrl?: string;
  /** Record middleware runs with no QA session header. Default false. */
  captureWithoutSession?: boolean;
  /** Capture request/response payloads of the middleware's calls. Default true, 32 KB each. */
  captureBodies?: { request?: boolean; response?: boolean; maxBytes?: number; redactKeys?: string[] };
  /** Outgoing calls never captured; same forms as the Node SDK's `ignoreOutgoing`. */
  ignoreOutgoing?: (string | RegExp)[];
  /** Record runs that made no backend call and did not redirect or fail. Default false. */
  recordAllRequests?: boolean;
}

type Middleware<Req extends Request, Evt, Res> = (request: Req, event: Evt) => Res | Promise<Res>;
type EdgeCall = Omit<ServerCall, 'seq'>;

interface Run {
  sessionId: string;
  traceId: string;
  spanId: string;
  calls: EdgeCall[];
  /** Body captures still being read; delivery waits for them, up to a bound. */
  pending: Promise<unknown>[];
}

interface AsyncStore<T> { getStore(): T | undefined; run<R>(store: T, fn: () => R): R }

const AMBIENT_SESSION_ID = 'apilens-ambient';
const MAX_BATCH = 50;
const MIN_TOKEN_LENGTH = 24;
const FETCH_KEY = Symbol.for('apilens.next.edgeFetch');
const STORE_KEY = Symbol.for('apilens.next.edgeStore');
const SETTLE_TIMEOUT_MS = 3_000;

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const safeId = (value: string | null): string | undefined => value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

/** Next's Edge runtime exposes AsyncLocalStorage globally; without it, overlapping runs share the latest one. */
function createStore(): AsyncStore<Run> {
  const Ctor = (globalThis as { AsyncLocalStorage?: new () => AsyncStore<Run> }).AsyncLocalStorage;
  if (Ctor) return new Ctor();
  let current: Run | undefined;
  return {
    getStore: () => current,
    run: (store, fn) => { current = store; try { return fn(); } finally { /* kept until the next run starts */ } },
  };
}

function matcher(rules: (string | RegExp)[]): (url: string) => boolean {
  return (raw) => {
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return rules.some((rule) => {
      if (rule instanceof RegExp) { rule.lastIndex = 0; return rule.test(raw); }
      const value = rule.trim().toLowerCase();
      if (!value) return false;
      if (value.includes('://')) return raw.toLowerCase().startsWith(value);
      if (value.startsWith(':')) return port === value.slice(1);
      if (value.includes(':')) return `${url.hostname}:${port}`.toLowerCase() === value;
      return url.hostname.toLowerCase() === value || url.hostname.toLowerCase().endsWith(`.${value}`);
    });
  };
}

async function capture(
  source: Request | Response | null, text: string | null, contentType: string | null, maxBytes: number, redactKeys: string[],
): Promise<{ body: CapturedBody | null; omitted: string | null }> {
  try {
    const raw = text ?? (source && source.body ? await source.clone().text() : null);
    if (raw === null || raw === '') return { body: null, omitted: null };
    if (contentType && !/json|text|xml|form-urlencoded|graphql|javascript/i.test(contentType)) {
      return { body: null, omitted: `Not captured: ${contentType.split(';')[0]} is not text` };
    }
    const truncated = raw.length > maxBytes;
    const redacted = redactBody(truncated ? raw.slice(0, maxBytes) : raw, contentType, redactKeys);
    return {
      body: { content: redacted.text, encoding: 'utf8', contentType, byteLength: Math.min(raw.length, maxBytes), truncated, redacted: redacted.redacted },
      omitted: null,
    };
  } catch {
    return { body: null, omitted: 'Not captured: body could not be read' };
  }
}

function record(input: {
  run: Run; spanId: string; parentSpanId: string | null; kind: 'server' | 'client'; serviceName: string;
  method: string; url: string; startedAt: number; statusCode: number | null; error: string | null;
  requestHeaders: Headers | null; responseHeaders: Headers | null;
  request: { body: CapturedBody | null; omitted: string | null }; response: { body: CapturedBody | null; omitted: string | null };
}): EdgeCall {
  const endedAt = Date.now();
  const parts = safeUrlParts(input.url);
  return {
    spanId: input.spanId, traceId: input.run.traceId, parentSpanId: input.parentSpanId, sessionId: input.run.sessionId,
    scenarioId: null, serviceName: input.serviceName, kind: input.kind, method: input.method,
    url: parts.url, origin: parts.origin, path: parts.path, query: parts.query,
    statusCode: input.statusCode, status: input.error || (input.statusCode ?? 0) >= 400 ? 'error' : 'ok',
    startedAt: input.startedAt, endedAt, durationMs: endedAt - input.startedAt,
    bodyDurationMs: input.response.body ? endedAt - input.startedAt : null,
    requestHeaders: redactHeaders(input.requestHeaders), responseHeaders: redactHeaders(input.responseHeaders),
    requestBody: input.request.body, responseBody: input.response.body,
    requestBodyOmitted: input.request.omitted, responseBodyOmitted: input.response.omitted,
    error: input.error, mockedBy: null,
  };
}

/**
 * Wraps a Next.js middleware so the backend calls it makes reach ApiLens.
 *
 *   // src/middleware.ts
 *   import { withApiLens } from '@apilens/next-sdk/edge';
 *   export const middleware = withApiLens(existingMiddleware, {
 *     enabled: process.env.APILENS_ENABLED === 'true',
 *     controlToken: process.env.APILENS_CONTROL_TOKEN,
 *     captureWithoutSession: true,
 *   });
 *
 * Disabled, or without a valid token, it returns the middleware unchanged.
 * Delivery never delays the response: it runs through `event.waitUntil`.
 */
export function withApiLens<Req extends Request, Evt, Res>(
  middleware: Middleware<Req, Evt, Res>,
  options: EdgeCaptureOptions,
): Middleware<Req, Evt, Res> {
  const token = options.controlToken ?? '';
  if (options.enabled !== true || token.length < MIN_TOKEN_LENGTH) return middleware;

  const serviceName = options.serviceName ?? 'next-middleware';
  const maxBytes = Math.max(0, Math.min(options.captureBodies?.maxBytes ?? 32 * 1024, 512 * 1024));
  const captureRequest = options.captureBodies?.request !== false && maxBytes > 0;
  const captureResponse = options.captureBodies?.response !== false && maxBytes > 0;
  const redactKeys = options.captureBodies?.redactKeys ?? [];
  // One store and one fetch patch per sandbox, however many times this is called.
  const shared = globalThis as typeof globalThis & { [STORE_KEY]?: AsyncStore<Run>; [FETCH_KEY]?: typeof fetch };
  const store = (shared[STORE_KEY] ??= createStore());
  const ignored = matcher([':8126', ':4317', ':4318', ...(options.ignoreOutgoing ?? [])]);

  // The SDK's own delivery uses the saved original, so it is never captured.
  const original = shared[FETCH_KEY] ?? globalThis.fetch;
  if (!shared[FETCH_KEY]) {
    shared[FETCH_KEY] = original;
    globalThis.fetch = async function apiLensEdgeFetch(input: RequestInfo | URL, init?: RequestInit) {
      const run = store.getStore();
      const url = input instanceof Request ? input.url : String(input);
      if (!run || ignored(url) || url.includes('/__apilens')) return original(input, init);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const startedAt = Date.now();
      const spanId = hex(8);
      const request = captureRequest
        ? capture(input instanceof Request && init?.body === undefined ? input : null, typeof init?.body === 'string' ? init.body : null, headers.get('content-type'), maxBytes, redactKeys)
        : Promise.resolve({ body: null, omitted: null });
      try {
        const response = await original(input, init);
        const captured = captureResponse ? capture(response, null, response.headers.get('content-type'), maxBytes, redactKeys) : Promise.resolve({ body: null, omitted: null });
        run.pending.push(Promise.all([request, captured]).then(([req, res]) => {
          run.calls.push(record({
            run, spanId, parentSpanId: run.spanId, kind: 'client', serviceName, method, url, startedAt,
            statusCode: response.status, error: null, requestHeaders: headers, responseHeaders: response.headers, request: req, response: res,
          }));
        }));
        return response;
      } catch (cause) {
        run.pending.push(request.then((req) => {
          run.calls.push(record({
            run, spanId, parentSpanId: run.spanId, kind: 'client', serviceName, method, url, startedAt,
            statusCode: null, error: cause instanceof Error ? cause.name : 'FetchError',
            requestHeaders: headers, responseHeaders: null, request: req, response: { body: null, omitted: null },
          }));
        }));
        throw cause;
      }
    } as typeof fetch;
  }

  return async function apiLensMiddleware(request: Req, event: Evt): Promise<Res> {
    let url: URL;
    try { url = new URL(request.url); } catch { return middleware(request, event); }
    if (/\/(?:__|%5F_)apilens(?:\/|$)/i.test(url.pathname)) return middleware(request, event);
    const sessionId = safeId(request.headers.get('x-qa-session-id')) ?? (options.captureWithoutSession ? AMBIENT_SESSION_ID : undefined);
    if (!sessionId) return middleware(request, event);

    const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(request.headers.get('traceparent') ?? '');
    const run: Run = { sessionId, traceId: parent?.[1] ?? hex(16), spanId: hex(8), calls: [], pending: [] };
    const startedAt = Date.now();
    let result: Res | undefined;
    let error: string | null = null;
    try {
      result = await store.run(run, () => middleware(request, event));
      return result;
    } catch (cause) {
      error = cause instanceof Error ? cause.name : 'MiddlewareError';
      throw cause;
    } finally {
      const response = result instanceof Response ? result : null;
      const deliver = (async () => {
        // Let the body captures of this run's calls settle first, but never wait unbounded.
        await Promise.race([
          Promise.allSettled(run.pending),
          new Promise((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
        ]);
        const status = response?.status ?? (error ? 500 : 200);
        const notable = run.calls.length > 0 || error !== null || status >= 300 || options.recordAllRequests === true;
        if (!notable) return;
        const calls = [record({
          run, spanId: run.spanId, parentSpanId: parent?.[2] ?? null, kind: 'server', serviceName, method: request.method.toUpperCase(),
          url: request.url, startedAt, statusCode: error ? null : status, error,
          requestHeaders: request.headers, responseHeaders: response?.headers ?? null,
          request: { body: null, omitted: 'Middleware request bodies are not read' }, response: { body: null, omitted: null },
        }), ...run.calls];
        const target = (options.ingestUrl ?? `${url.origin}/api/__apilens`).replace(/\/$/, '');
        for (let index = 0; index < calls.length; index += MAX_BATCH) {
          await original(`${target}/ingest`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ calls: calls.slice(index, index + MAX_BATCH) }),
          }).catch(() => undefined);
        }
      })();
      const waitUntil = (event as { waitUntil?: (promise: Promise<unknown>) => void } | null)?.waitUntil;
      if (typeof waitUntil === 'function') waitUntil.call(event, deliver);
      else void deliver;
    }
  };
}
