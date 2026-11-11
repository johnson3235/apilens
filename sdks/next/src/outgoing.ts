import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { decodeBody, nodeHeaders } from './incoming';

/**
 * Process-level hook into Node's HTTP client.
 *
 * axios, got, node-fetch, superagent, SOAP and most SDK clients send through
 * `http.request`/`https.request` rather than global `fetch`, so hooking those
 * two functions covers them all centrally, again without application code.
 */

type RequestFn = (...args: unknown[]) => ClientRequest;

export interface OutgoingCall {
  method: string;
  url: string;
  /** Headers known when the request was created; later `setHeader` calls are read from the request. */
  headers: Headers;
  /** The arguments exactly as the caller passed them. */
  args: unknown[];
  callback: ((res: IncomingMessage) => void) | null;
  timeoutMs: number | null;
  signal: AbortSignal | null;
}

export type OutgoingHook = (call: OutgoingCall, original: RequestFn) => ClientRequest;

const HOOK = Symbol.for('apilens.next.outgoingHook');
// On globalThis so dev/HMR re-evaluation of this module never patches twice.
const state = globalThis as typeof globalThis & {
  [HOOK]?: { hook: OutgoingHook | null; originals: { http: RequestFn; https: RequestFn }; restore: () => void };
};

/** The real `http.request`, for the SDK's own traffic, which must never be captured. */
export function unpatchedHttpRequest(): typeof http.request {
  return (state[HOOK]?.originals.http ?? http.request) as typeof http.request;
}

export function setOutgoingHook(hook: OutgoingHook): void {
  if (!state[HOOK]) {
    const modules = { http, https } as unknown as Record<'http' | 'https', { request: RequestFn; get: RequestFn }>;
    const originals = { http: modules.http.request, https: modules.https.request };
    const originalGets = { http: modules.http.get, https: modules.https.get };
    const installed: Partial<Record<'http' | 'https', { request: RequestFn; get: RequestFn }>> = {};
    state[HOOK] = {
      hook: null,
      originals,
      restore: () => {
        for (const name of ['http', 'https'] as const) {
          const mod = modules[name];
          // Only undo a patch that is still outermost; a later wrapper keeps working, inert.
          if (mod.request === installed[name]?.request) mod.request = originals[name];
          if (mod.get === installed[name]?.get) mod.get = originalGets[name];
        }
        syncBuiltinESMExports();
      },
    };
    for (const name of ['http', 'https'] as const) {
      const mod = modules[name];
      const original: RequestFn = (...args) => originals[name].apply(mod, args);
      mod.request = function apiLensRequest(...args: unknown[]) {
        const active = state[HOOK]?.hook;
        if (!active) return original(...args);
        let call: OutgoingCall;
        try {
          call = describe(`${name}:`, args);
        } catch {
          return original(...args);
        }
        return active(call, original);
      };
      // `get` calls the module-private `request`, so it is rebuilt on the patched one.
      mod.get = function apiLensGet(...args: unknown[]) {
        const request = mod.request(...args);
        request.end();
        return request;
      };
      installed[name] = { request: mod.request, get: mod.get };
    }
    // ESM `import { request } from 'node:http'` bindings only follow this call.
    syncBuiltinESMExports();
  }
  state[HOOK].hook = hook;
}

/** Detaches `hook` and, when nothing has wrapped them since, restores Node's own client functions. */
export function clearOutgoingHook(hook: OutgoingHook): void {
  const current = state[HOOK];
  if (current?.hook !== hook) return;
  current.hook = null;
  current.restore();
  delete state[HOOK];
}

/** Reads `request(url?, options?, callback?)` the way Node does. */
function describe(defaultProtocol: string, args: unknown[]): OutgoingCall {
  let url: URL | null = null;
  let options: RequestOptions = {};
  let callback: unknown = null;
  const [first, second, third] = args;
  if (typeof first === 'string' || first instanceof URL) {
    url = new URL(String(first));
    if (typeof second === 'function') callback = second;
    else {
      options = (second as RequestOptions | undefined) ?? {};
      callback = third;
    }
  } else {
    options = (first as RequestOptions | undefined) ?? {};
    callback = second;
  }

  const protocol = options.protocol ?? url?.protocol ?? defaultProtocol;
  const rawHost = options.hostname ?? options.host ?? url?.hostname ?? 'localhost';
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
  const port = options.port ?? (url?.port || null);
  const path = options.path ?? (url ? `${url.pathname}${url.search}` : '/');
  const display = `${protocol}//${host}${port ? `:${port}` : ''}${path.startsWith('/') ? path : `/${path}`}`;
  let normalised = display;
  try { normalised = new URL(display).toString(); } catch { /* keep the raw form */ }

  const headers = new Headers();
  const raw = options.headers;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) headers.append(String(raw[i]), String(raw[i + 1]));
  } else if (raw) {
    nodeHeaders(raw as OutgoingHttpHeaders).forEach((value, name) => headers.set(name, value));
  }

  return {
    method: (options.method ?? 'GET').toUpperCase(),
    url: normalised,
    headers,
    args,
    callback: typeof callback === 'function' ? callback as (res: IncomingMessage) => void : null,
    timeoutMs: typeof options.timeout === 'number' ? options.timeout : null,
    signal: options.signal ?? null,
  };
}

/** Error shapes HTTP clients recognise (axios, got, etc. read `code`). */
export function simulatedConnectionError(ruleName: string): Error {
  return Object.assign(new Error(`connect ECONNREFUSED (simulated by ApiLens rule "${ruleName}")`), {
    code: 'ECONNREFUSED', errno: -111, syscall: 'connect',
  });
}

/**
 * Performs the real request and buffers the whole response as a `Response`,
 * decompressed. Used when a mock needs the real answer first.
 */
export function realResponse(original: RequestFn, call: OutgoingCall, body: Buffer, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = original(...call.args.filter((arg) => typeof arg !== 'function'));
    const abort = () => request.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', abort, { once: true });
    request.once('error', reject);
    request.once('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', async () => {
        signal.removeEventListener('abort', abort);
        const headers = nodeHeaders(res.headers);
        let bytes = Buffer.concat(chunks);
        const encoding = headers.get('content-encoding');
        if (encoding) {
          const decoded = await decodeBody(bytes, encoding, 8 * 1024 * 1024);
          if (decoded) {
            bytes = decoded;
            headers.delete('content-encoding');
            headers.delete('content-length');
          }
        }
        const status = res.statusCode && res.statusCode >= 200 && res.statusCode <= 599 ? res.statusCode : 502;
        const empty = [204, 205, 304].includes(status) || bytes.byteLength === 0;
        resolve(new Response(empty ? null : bytes, { status, statusText: res.statusMessage ?? '', headers }));
      });
    });
    request.end(body.byteLength ? body : undefined);
  });
}

/**
 * Stands in for a `ClientRequest` whose answer comes from a mock rule.
 *
 * It accepts writes and piping like the real thing, honours `setTimeout`,
 * `abort`/`destroy` and an `AbortSignal`, then emits a `response` that reads
 * like an `IncomingMessage`, or an `error` for simulated network failures.
 */
export class MockedClientRequest extends Writable {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly protocol: string;
  readonly reusedSocket = false;
  aborted = false;
  private readonly headerMap: Headers;
  private readonly chunks: Buffer[] = [];
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(call: OutgoingCall, private readonly respond: (body: Buffer, signal: AbortSignal) => Promise<Response>) {
    // Not auto-destroyed after end(): the answer arrives later, and destroying
    // would abort it. It closes once its response has been read instead.
    super({ autoDestroy: false });
    const url = new URL(call.url);
    this.method = call.method;
    this.path = `${url.pathname}${url.search}`;
    this.host = url.hostname;
    this.protocol = url.protocol;
    this.headerMap = new Headers(call.headers);
    if (call.callback) this.once('response', call.callback);
    if (call.timeoutMs !== null) this.setTimeout(call.timeoutMs);
    if (call.signal) {
      if (call.signal.aborted) queueMicrotask(() => this.abort());
      else call.signal.addEventListener('abort', () => this.abort(), { once: true });
    }
  }

  get headersSent(): boolean { return this.writableEnded; }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headerMap.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    return this;
  }
  getHeader(name: string): string | undefined { return this.headerMap.get(name) ?? undefined; }
  getHeaders(): Record<string, string> { return Object.fromEntries(this.headerMap.entries()); }
  getHeaderNames(): string[] { return [...this.headerMap.keys()]; }
  hasHeader(name: string): boolean { return this.headerMap.has(name); }
  removeHeader(name: string): void { this.headerMap.delete(name); }
  /** The request's headers as they would be sent, including later `setHeader` calls. */
  currentHeaders(): Headers { return new Headers(this.headerMap); }

  setTimeout(ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback);
    if (this.timer) clearTimeout(this.timer);
    this.timer = ms > 0 ? setTimeout(() => this.emit('timeout'), ms) : null;
    this.timer?.unref?.();
    return this;
  }
  setNoDelay(): void {}
  setSocketKeepAlive(): void {}
  flushHeaders(): void {}

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.emit('abort');
    this.destroy();
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    done();
  }

  override _final(done: (error?: Error | null) => void): void {
    done();
    void this.resolve();
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    done(error);
  }

  private async resolve(): Promise<void> {
    try {
      const response = await this.respond(Buffer.concat(this.chunks), this.controller.signal);
      const body = Buffer.from(await response.arrayBuffer());
      if (this.destroyed) return;
      if (this.timer) clearTimeout(this.timer);
      const message = incomingFrom(response, body, this);
      message.once('end', () => this.destroy());
      this.emit('response', message);
    } catch (error) {
      if (!this.destroyed) this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** A readable that carries the fields clients read from an `IncomingMessage`. */
function incomingFrom(response: Response, body: Buffer, request: MockedClientRequest): IncomingMessage {
  const message = new PassThrough();
  const headers: Record<string, string | string[]> = {};
  const rawHeaders: string[] = [];
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    headers[name] = value;
    rawHeaders.push(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) {
    headers['set-cookie'] = cookies;
    for (const cookie of cookies) rawHeaders.push('set-cookie', cookie);
  }
  Object.assign(message, {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers,
    rawHeaders,
    trailers: {},
    rawTrailers: [],
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    aborted: false,
    url: '',
    method: null,
    socket: null,
    req: request,
    setTimeout: () => message,
  });
  // Ended after the `response` listeners have attached their own handlers.
  queueMicrotask(() => message.end(body));
  return message as unknown as IncomingMessage;
}
