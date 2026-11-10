"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BodyTap = void 0;
exports.setRequestHook = setRequestHook;
exports.clearRequestHook = clearRequestHook;
exports.nodeHeaders = nodeHeaders;
exports.trackResponseHeaders = trackResponseHeaders;
exports.tapRequest = tapRequest;
exports.tapWrites = tapWrites;
exports.decodeBody = decodeBody;
const node_http_1 = require("node:http");
const node_https_1 = require("node:https");
const node_zlib_1 = require("node:zlib");
const HOOK = Symbol.for('apilens.next.requestHook');
// On globalThis so dev/HMR re-evaluation of this module never patches twice.
const state = globalThis;
function setRequestHook(hook) {
    if (!state[HOOK]) {
        state[HOOK] = { hook: null };
        for (const proto of [node_http_1.Server.prototype, node_https_1.Server.prototype]) {
            const original = proto.emit;
            proto.emit = function apiLensEmit(event, ...args) {
                const dispatch = () => original.call(this, event, ...args);
                const active = state[HOOK]?.hook;
                if (event !== 'request' || !active)
                    return dispatch();
                return active(args[0], args[1], dispatch);
            };
        }
    }
    state[HOOK].hook = hook;
}
/** Detaches `hook` if it is still the active one; the patch itself stays inert. */
function clearRequestHook(hook) {
    if (state[HOOK]?.hook === hook)
        state[HOOK].hook = null;
}
function nodeHeaders(raw) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(raw)) {
        if (value === undefined)
            continue;
        try {
            for (const item of Array.isArray(value) ? value : [value])
                headers.append(name, String(item));
        }
        catch {
            // A header value the Fetch API rejects is simply not shown.
        }
    }
    return headers;
}
/**
 * Response headers as sent. Headers passed straight to `writeHead` never
 * reach `getHeaders()`, so they are recorded on the way through.
 */
function trackResponseHeaders(res) {
    let direct = null;
    const writeHead = res.writeHead;
    res.writeHead = function apiLensWriteHead(...args) {
        try {
            const raw = args.find((arg, index) => index > 0 && arg !== null && typeof arg === 'object');
            if (Array.isArray(raw)) {
                direct = new Headers();
                for (let i = 0; i + 1 < raw.length; i += 2)
                    direct.append(String(raw[i]), String(raw[i + 1]));
            }
            else if (raw) {
                direct = nodeHeaders(raw);
            }
        }
        catch { /* never break the response */ }
        return writeHead.apply(this, args);
    };
    return () => {
        const headers = nodeHeaders(res.getHeaders());
        direct?.forEach((value, name) => headers.set(name, value));
        return headers;
    };
}
/** Bounded copy of the chunks a stream carries; the stream itself is untouched. */
class BodyTap {
    cap;
    chunks = [];
    size = 0;
    truncated = false;
    constructor(cap) {
        this.cap = cap;
    }
    add(chunk, encoding) {
        if (chunk === null || chunk === undefined)
            return;
        const bytes = typeof chunk === 'string'
            ? Buffer.from(chunk, typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8')
            : chunk instanceof Uint8Array ? chunk : null;
        if (!bytes || bytes.byteLength === 0)
            return;
        const room = this.cap - this.size;
        if (bytes.byteLength > room)
            this.truncated = true;
        if (room <= 0)
            return;
        // Copied, because callers may reuse their buffers after write().
        const kept = Buffer.from(bytes.subarray(0, room));
        this.chunks.push(kept);
        this.size += kept.byteLength;
    }
    bytes() {
        return Buffer.concat(this.chunks);
    }
}
exports.BodyTap = BodyTap;
/**
 * Copies an incoming body as Node's parser pushes it.
 *
 * Listening for `data` would switch the stream to flowing mode and steal the
 * body from the application, so the copy is taken at `push` instead.
 */
function tapRequest(req, cap) {
    const tap = new BodyTap(cap);
    const push = req.push;
    req.push = function apiLensPush(chunk, encoding) {
        try {
            tap.add(chunk, encoding);
        }
        catch { /* never break the request */ }
        return push.call(this, chunk, encoding);
    };
    return tap;
}
/** Copies what the application writes to an outgoing message (a server response or a client request). */
function tapWrites(message, cap) {
    const tap = new BodyTap(cap);
    const write = message.write;
    const end = message.end;
    message.write = function apiLensWrite(...args) {
        try {
            tap.add(args[0], args[1]);
        }
        catch { /* never break the message */ }
        return write.apply(this, args);
    };
    message.end = function apiLensEnd(...args) {
        try {
            if (typeof args[0] !== 'function')
                tap.add(args[0], args[1]);
        }
        catch { /* never break the message */ }
        return end.apply(this, args);
    };
    return tap;
}
/**
 * Undoes transfer compression (`next start` gzips by default) on a possibly
 * truncated capture. Returns null when the encoding is unknown or corrupt.
 */
function decodeBody(bytes, contentEncoding, cap) {
    const encoding = (contentEncoding ?? '').trim().toLowerCase();
    if (!encoding || encoding === 'identity')
        return bytes;
    // A bounded output keeps a decompression bomb out of memory.
    const limits = { maxOutputLength: Math.max(cap * 4, 1 << 20) };
    try {
        if (encoding === 'gzip' || encoding === 'x-gzip')
            return (0, node_zlib_1.gunzipSync)(bytes, { ...limits, finishFlush: node_zlib_1.constants.Z_SYNC_FLUSH });
        if (encoding === 'deflate')
            return (0, node_zlib_1.inflateSync)(bytes, { ...limits, finishFlush: node_zlib_1.constants.Z_SYNC_FLUSH });
        if (encoding === 'br')
            return (0, node_zlib_1.brotliDecompressSync)(bytes, { ...limits, finishFlush: node_zlib_1.constants.BROTLI_OPERATION_FLUSH });
    }
    catch {
        return null;
    }
    return null;
}
//# sourceMappingURL=incoming.js.map