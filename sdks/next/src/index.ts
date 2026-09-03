import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

/** Wire-compatible with ApiLens TraceSpan; no workspace runtime/type dependencies. */
export interface ServerSpan {
  traceId: string; spanId: string; parentSpanId: string | null; sessionId: string;
  serviceName: string; operationName: string; kind: 'server' | 'client';
  source: 'internal-service'; channel: 'server-sdk'; method: string; url: string;
  statusCode: number | null; status: 'ok' | 'error'; startedAt: number; endedAt: number;
  durationMs: number; attributes: Record<string, string | number | boolean>;
  events: never[]; error: string | null; mockedBy: null;
}

export interface NextSDKOptions {
  serviceName: string;
  /** Explicit opt-in on a controlled Node-runtime QA deployment. Default false. */
  enabled?: boolean;
  agentUrl?: string;
  /** Server-only secret. Must match the token configured in the extension. */
  agentToken?: string;
  /** Exact application origins eligible for incoming QA context. */
  allowedAppOrigins: string[];
  /** Optional trusted downstream origins receiving correlation headers. Default none. */
  propagateToOrigins?: string[];
}

interface Context { sessionId: string; scenarioId?: string; traceId: string; spanId: string }
const id = (bytes: number) => randomBytes(bytes).toString('hex');
const safeId = (value: string | null): string | undefined => value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

export function safeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [name,
    /authorization|cookie|token|secret|password|api[-_]?key|session|apilens-rules/i.test(name) ? '[REDACTED]' : value.slice(0, 2048),
  ]));
}

function safeUrl(value: string): string {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? `${url.origin}${url.pathname}` : '[non-HTTP URL]'; } catch { return '[invalid URL]'; }
}

/** Local-only transport, authenticated /v1/spans, never uses instrumented fetch. */
class Reporter {
  private pending: ServerSpan[] = [];
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly diagnostics = { accepted: 0, dropped: 0, lastError: null as string | null };
  private readonly endpoint: URL;

  constructor(private readonly options: NextSDKOptions) {
    this.endpoint = new URL('/v1/spans', options.agentUrl ?? 'http://127.0.0.1:7317');
    if (this.endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(this.endpoint.hostname) || this.endpoint.username || this.endpoint.password) {
      throw new Error('ApiLens requires an HTTP loopback agent in this release.');
    }
  }

  add(span: ServerSpan): void {
    if (this.pending.length >= 1000) { this.diagnostics.dropped++; return; }
    this.pending.push(span);
    if (!this.timer) { this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref(); }
  }

  async flush(): Promise<void> {
    if (this.active) { await this.active; return this.flush(); }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, 100);
    this.active = (async () => {
      // Agent ingestion accepts one session per request; never mix concurrent testers.
      const groups = new Map<string, ServerSpan[]>();
      for (const span of batch) groups.set(span.sessionId, [...(groups.get(span.sessionId) ?? []), span]);
      for (const [sessionId, spans] of groups) {
        try {
          await this.send(JSON.stringify({ sessionId, spans }));
          this.diagnostics.accepted += spans.length; this.diagnostics.lastError = null;
        } catch (error) {
          this.diagnostics.dropped += spans.length;
          this.diagnostics.lastError = error instanceof Error ? error.message : 'Agent delivery failed';
        }
      }
    })();
    try { await this.active; } finally { this.active = null; }
    // Bounded flush: later calls flush requests that arrived during this batch.
  }

  private send(body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(this.endpoint, { method: 'POST', headers: {
        authorization: `Bearer ${this.options.agentToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      } }, (response) => {
        response.resume();
        response.on('error', () => reject(new Error('Agent response failed')));
        response.on('end', () => response.statusCode === 202 ? resolve() : reject(new Error(`Agent HTTP ${response.statusCode}`)));
      });
      const timeout = setTimeout(() => request.destroy(new Error('Agent delivery timed out')), 2000);
      timeout.unref();
      request.on('close', () => clearTimeout(timeout));
      request.on('error', () => reject(new Error('Agent unavailable or request timed out')));
      request.end(body);
    });
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
    while (this.pending.length) await this.flush();
  }
}

export class ApiLensNextSDK {
  private readonly contexts = new AsyncLocalStorage<Context>();
  private readonly insideFetch = new AsyncLocalStorage<boolean>();
  private readonly reporter: Reporter;
  private wrapper: typeof fetch | null = null;
  private downstream: typeof fetch | null = null;
  private stopped = false;
  private readonly allowed: Set<string>;
  private readonly propagate: Set<string>;

  constructor(private readonly options: NextSDKOptions) {
    if (options.enabled && !options.agentToken) throw new Error('ApiLens agentToken is required when enabled.');
    this.allowed = new Set(options.allowedAppOrigins.map((origin) => new URL(origin).origin));
    this.propagate = new Set((options.propagateToOrigins ?? []).map((origin) => new URL(origin).origin));
    this.reporter = new Reporter(options);
  }

  get diagnostics() { return { ...this.reporter.diagnostics }; }
  get enabled(): boolean { return this.options.enabled === true && !this.stopped; }

  /** Call from instrumentation.ts register(), and once per route to tolerate Next's fetch patching. */
  installFetch(): void {
    if (!this.enabled || globalThis.fetch === this.wrapper) return;
    const downstream = globalThis.fetch;
    const sdk = this;
    this.downstream = downstream;
    this.wrapper = async function apiLensFetch(input, init) {
      const ctx = sdk.contexts.getStore();
      if (!sdk.enabled || !ctx || sdk.insideFetch.getStore()) return downstream(input, init);
      return sdk.insideFetch.run(true, async () => {
        const requestInput = input instanceof Request ? input : null;
        const url = requestInput?.url ?? String(input);
        const method = (init?.method ?? requestInput?.method ?? 'GET').toUpperCase();
        const headers = new Headers(init?.headers ?? requestInput?.headers);
        const spanId = id(8), startedAt = Date.now();
        let statusCode: number | null = null, responseHeaders: Headers | null = null, error: string | null = null;
        let outgoing = init;
        try {
          if (sdk.propagate.has(new URL(url).origin)) {
            headers.set('traceparent', `00-${ctx.traceId}-${spanId}-01`);
            headers.set('x-qa-session-id', ctx.sessionId);
            if (ctx.scenarioId) headers.set('x-test-scenario-id', ctx.scenarioId);
            outgoing = { ...init, headers }; // Keep body, signal, cache, next and duplex untouched.
          }
          const response = await downstream(input, outgoing);
          statusCode = response.status; responseHeaders = response.headers;
          return response; // Do not consume or clone streaming bodies.
        } catch (cause) { error = cause instanceof Error ? cause.name : 'FetchError'; throw cause; }
        finally { sdk.record(ctx, spanId, ctx.spanId, 'client', method, url, startedAt, statusCode, headers, responseHeaders, error); }
      });
    };
    globalThis.fetch = this.wrapper;
  }

  /** Preserves NextRequest and params context; never executes server mock rules. */
  wrapRoute<R extends Request, C>(handler: (request: R, context: C) => Response | Promise<Response>): (request: R, context: C) => Promise<Response> {
    return async (request, context) => {
      const sessionId = safeId(request.headers.get('x-qa-session-id'));
      if (!this.enabled || !sessionId || !this.allowed.has(new URL(request.url).origin)) return handler(request, context);
      this.installFetch();
      const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(request.headers.get('traceparent') ?? '');
      const validParent = parent && !/^0+$/.test(parent[1]) && !/^0+$/.test(parent[2]) ? parent : null;
      const ctx: Context = { sessionId, scenarioId: safeId(request.headers.get('x-test-scenario-id')), traceId: validParent?.[1] ?? id(16), spanId: id(8) };
      const startedAt = Date.now();
      return this.contexts.run(ctx, async () => {
        let response: Response | undefined, error: string | null = null;
        try { response = await handler(request, context); return response; }
        catch (cause) { error = cause instanceof Error ? cause.name : 'HandlerError'; throw cause; }
        finally { this.record(ctx, ctx.spanId, validParent?.[2] ?? null, 'server', request.method, request.url, startedAt, response?.status ?? null, request.headers, response?.headers ?? null, error); }
      });
    };
  }

  private record(ctx: Context, spanId: string, parentSpanId: string | null, kind: 'server' | 'client', method: string, url: string, startedAt: number, statusCode: number | null, headers: Headers, responseHeaders: Headers | null, error: string | null): void {
    if (!this.enabled) return;
    const endedAt = Date.now();
    this.reporter.add({ traceId: ctx.traceId, spanId, parentSpanId, sessionId: ctx.sessionId, serviceName: this.options.serviceName,
      operationName: `${method} ${safeUrl(url)}`, kind, source: 'internal-service', channel: 'server-sdk', method, url: safeUrl(url), statusCode,
      status: error || (statusCode ?? 0) >= 400 ? 'error' : 'ok', startedAt, endedAt, durationMs: endedAt - startedAt,
      attributes: { requestHeaders: JSON.stringify(safeHeaders(headers)), responseHeaders: JSON.stringify(responseHeaders ? safeHeaders(responseHeaders) : {}),
        scenario: ctx.scenarioId ?? '', timingScope: 'response-headers', bodyCapture: false }, events: [], error, mockedBy: null });
  }

  flush(): Promise<void> { return this.reporter.flush(); }
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (globalThis.fetch === this.wrapper && this.downstream) globalThis.fetch = this.downstream;
    await this.reporter.shutdown();
  }
}
