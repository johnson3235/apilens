import {
  Server as HttpServer, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type OutgoingMessage, type ServerResponse,
} from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { brotliDecompressSync, constants as zlib, gunzipSync, inflateSync } from 'node:zlib';

/**
 * Process-level hook into every incoming Node HTTP request.
 *
 * `next start`, `next dev`, standalone output and custom servers all serve
 * through `http.Server`, so hooking its `request` event gives the SDK a
 * context for every page render, RSC payload, server action and route
 * handler, without a single line in application code. The hook receives
 * `dispatch`, which runs the server's own handling; whatever async context
 * the hook opens around it follows the request through Next.
 */
export type RequestHook = (req: IncomingMessage, res: ServerResponse, dispatch: () => boolean) => boolean;

const HOOK = Symbol.for('apilens.next.requestHook');
// On globalThis so dev/HMR re-evaluation of this module never patches twice.
const state = globalThis as typeof globalThis & { [HOOK]?: { hook: RequestHook | null } };

type Emit = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;

export function setRequestHook(hook: RequestHook): void {
  if (!state[HOOK]) {
    state[HOOK] = { hook: null };
    for (const proto of [HttpServer.prototype, HttpsServer.prototype] as unknown as { emit: Emit }[]) {
      const original = proto.emit;
      proto.emit = function apiLensEmit(event, ...args) {
        const dispatch = () => original.call(this, event, ...args);
        const active = state[HOOK]?.hook;
        if (event !== 'request' || !active) return dispatch();
        return active(args[0] as IncomingMessage, args[1] as ServerResponse, dispatch);
      };
    }
  }
  state[HOOK].hook = hook;
}

/** Detaches `hook` if it is still the active one; the patch itself stays inert. */
export function clearRequestHook(hook: RequestHook): void {
  if (state[HOOK]?.hook === hook) state[HOOK].hook = null;
}

export function nodeHeaders(raw: IncomingHttpHeaders | OutgoingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    try {
      for (const item of Array.isArray(value) ? value : [value]) headers.append(name, String(item));
    } catch {
      // A header value the Fetch API rejects is simply not shown.
    }
  }
  return headers;
}

/**
 * Response headers as sent. Headers passed straight to `writeHead` never
 * reach `getHeaders()`, so they are recorded on the way through.
 */
export function trackResponseHeaders(res: ServerResponse): () => Headers {
  let direct: Headers | null = null;
  const writeHead = res.writeHead as (...args: unknown[]) => ServerResponse;
  res.writeHead = function apiLensWriteHead(this: ServerResponse, ...args: unknown[]) {
    try {
      const raw = args.find((arg, index) => index > 0 && arg !== null && typeof arg === 'object');
      if (Array.isArray(raw)) {
        direct = new Headers();
        for (let i = 0; i + 1 < raw.length; i += 2) direct.append(String(raw[i]), String(raw[i + 1]));
      } else if (raw) {
        direct = nodeHeaders(raw as OutgoingHttpHeaders);
      }
    } catch { /* never break the response */ }
    return writeHead.apply(this, args);
  } as ServerResponse['writeHead'];
  return () => {
    const headers = nodeHeaders(res.getHeaders());
    direct?.forEach((value, name) => headers.set(name, value));
    return headers;
  };
}

/** Bounded copy of the chunks a stream carries; the stream itself is untouched. */
export class BodyTap {
  private chunks: Buffer[] = [];
  size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  add(chunk: unknown, encoding?: unknown): void {
    if (chunk === null || chunk === undefined) return;
    const bytes = typeof chunk === 'string'
      ? Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8')
      : chunk instanceof Uint8Array ? chunk : null;
    if (!bytes || bytes.byteLength === 0) return;
    const room = this.cap - this.size;
    if (bytes.byteLength > room) this.truncated = true;
    if (room <= 0) return;
    // Copied, because callers may reuse their buffers after write().
    const kept = Buffer.from(bytes.subarray(0, room));
    this.chunks.push(kept);
    this.size += kept.byteLength;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * Copies an incoming body as Node's parser pushes it.
 *
 * Listening for `data` would switch the stream to flowing mode and steal the
 * body from the application, so the copy is taken at `push` instead.
 */
export function tapRequest(req: IncomingMessage, cap: number): BodyTap {
  const tap = new BodyTap(cap);
  const push = req.push;
  req.push = function apiLensPush(chunk: unknown, encoding?: BufferEncoding) {
    try { tap.add(chunk, encoding); } catch { /* never break the request */ }
    return push.call(this, chunk, encoding);
  };
  return tap;
}

/** Copies what the application writes to an outgoing message (a server response or a client request). */
export function tapWrites(message: OutgoingMessage, cap: number): BodyTap {
  const tap = new BodyTap(cap);
  const write = message.write as (...args: unknown[]) => boolean;
  const end = message.end as (...args: unknown[]) => OutgoingMessage;
  message.write = function apiLensWrite(this: OutgoingMessage, ...args: unknown[]) {
    try { tap.add(args[0], args[1]); } catch { /* never break the message */ }
    return write.apply(this, args);
  } as OutgoingMessage['write'];
  message.end = function apiLensEnd(this: OutgoingMessage, ...args: unknown[]) {
    try { if (typeof args[0] !== 'function') tap.add(args[0], args[1]); } catch { /* never break the message */ }
    return end.apply(this, args);
  } as OutgoingMessage['end'];
  return tap;
}

/**
 * Undoes transfer compression (`next start` gzips by default) on a possibly
 * truncated capture. Returns null when the encoding is unknown or corrupt.
 */
export function decodeBody(bytes: Buffer, contentEncoding: string | null, cap: number): Buffer | null {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return bytes;
  // A bounded output keeps a decompression bomb out of memory.
  const limits = { maxOutputLength: Math.max(cap * 4, 1 << 20) };
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(bytes, { ...limits, finishFlush: zlib.Z_SYNC_FLUSH });
    if (encoding === 'deflate') return inflateSync(bytes, { ...limits, finishFlush: zlib.Z_SYNC_FLUSH });
    if (encoding === 'br') return brotliDecompressSync(bytes, { ...limits, finishFlush: zlib.BROTLI_OPERATION_FLUSH });
  } catch {
    return null;
  }
  return null;
}
