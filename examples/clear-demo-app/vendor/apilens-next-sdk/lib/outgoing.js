"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockedClientRequest = void 0;
exports.unpatchedHttpRequest = unpatchedHttpRequest;
exports.setOutgoingHook = setOutgoingHook;
exports.clearOutgoingHook = clearOutgoingHook;
exports.simulatedConnectionError = simulatedConnectionError;
exports.realResponse = realResponse;
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const node_module_1 = require("node:module");
const node_stream_1 = require("node:stream");
const incoming_1 = require("./incoming");
const HOOK = Symbol.for('apilens.next.outgoingHook');
// On globalThis so dev/HMR re-evaluation of this module never patches twice.
const state = globalThis;
/** The real `http.request`, for the SDK's own traffic, which must never be captured. */
function unpatchedHttpRequest() {
    return (state[HOOK]?.originals.http ?? node_http_1.default.request);
}
function setOutgoingHook(hook) {
    if (!state[HOOK]) {
        const modules = { http: node_http_1.default, https: node_https_1.default };
        const originals = { http: modules.http.request, https: modules.https.request };
        state[HOOK] = { hook: null, originals };
        for (const name of ['http', 'https']) {
            const mod = modules[name];
            const original = (...args) => originals[name].apply(mod, args);
            mod.request = function apiLensRequest(...args) {
                const active = state[HOOK]?.hook;
                if (!active)
                    return original(...args);
                let call;
                try {
                    call = describe(`${name}:`, args);
                }
                catch {
                    return original(...args);
                }
                return active(call, original);
            };
            // `get` calls the module-private `request`, so it is rebuilt on the patched one.
            mod.get = function apiLensGet(...args) {
                const request = mod.request(...args);
                request.end();
                return request;
            };
        }
        // ESM `import { request } from 'node:http'` bindings only follow this call.
        (0, node_module_1.syncBuiltinESMExports)();
    }
    state[HOOK].hook = hook;
}
function clearOutgoingHook(hook) {
    if (state[HOOK]?.hook === hook)
        state[HOOK].hook = null;
}
/** Reads `request(url?, options?, callback?)` the way Node does. */
function describe(defaultProtocol, args) {
    let url = null;
    let options = {};
    let callback = null;
    const [first, second, third] = args;
    if (typeof first === 'string' || first instanceof URL) {
        url = new URL(String(first));
        if (typeof second === 'function')
            callback = second;
        else {
            options = second ?? {};
            callback = third;
        }
    }
    else {
        options = first ?? {};
        callback = second;
    }
    const protocol = options.protocol ?? url?.protocol ?? defaultProtocol;
    const rawHost = options.hostname ?? options.host ?? url?.hostname ?? 'localhost';
    const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
    const port = options.port ?? (url?.port || null);
    const path = options.path ?? (url ? `${url.pathname}${url.search}` : '/');
    const display = `${protocol}//${host}${port ? `:${port}` : ''}${path.startsWith('/') ? path : `/${path}`}`;
    let normalised = display;
    try {
        normalised = new URL(display).toString();
    }
    catch { /* keep the raw form */ }
    const headers = new Headers();
    const raw = options.headers;
    if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2)
            headers.append(String(raw[i]), String(raw[i + 1]));
    }
    else if (raw) {
        (0, incoming_1.nodeHeaders)(raw).forEach((value, name) => headers.set(name, value));
    }
    return {
        method: (options.method ?? 'GET').toUpperCase(),
        url: normalised,
        headers,
        args,
        callback: typeof callback === 'function' ? callback : null,
        timeoutMs: typeof options.timeout === 'number' ? options.timeout : null,
        signal: options.signal ?? null,
    };
}
/** Error shapes HTTP clients recognise (axios, got, etc. read `code`). */
function simulatedConnectionError(ruleName) {
    return Object.assign(new Error(`connect ECONNREFUSED (simulated by ApiLens rule "${ruleName}")`), {
        code: 'ECONNREFUSED', errno: -111, syscall: 'connect',
    });
}
/**
 * Performs the real request and buffers the whole response as a `Response`,
 * decompressed. Used when a mock needs the real answer first.
 */
function realResponse(original, call, body, signal) {
    return new Promise((resolve, reject) => {
        const request = original(...call.args.filter((arg) => typeof arg !== 'function'));
        const abort = () => request.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', abort, { once: true });
        request.once('error', reject);
        request.once('response', (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.once('error', reject);
            res.once('end', () => {
                signal.removeEventListener('abort', abort);
                const headers = (0, incoming_1.nodeHeaders)(res.headers);
                let bytes = Buffer.concat(chunks);
                const encoding = headers.get('content-encoding');
                if (encoding) {
                    const decoded = (0, incoming_1.decodeBody)(bytes, encoding, 8 * 1024 * 1024);
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
class MockedClientRequest extends node_stream_1.Writable {
    respond;
    method;
    path;
    host;
    protocol;
    reusedSocket = false;
    aborted = false;
    headerMap;
    chunks = [];
    controller = new AbortController();
    timer = null;
    constructor(call, respond) {
        // Not auto-destroyed after end(): the answer arrives later, and destroying
        // would abort it. It closes once its response has been read instead.
        super({ autoDestroy: false });
        this.respond = respond;
        const url = new URL(call.url);
        this.method = call.method;
        this.path = `${url.pathname}${url.search}`;
        this.host = url.hostname;
        this.protocol = url.protocol;
        this.headerMap = new Headers(call.headers);
        if (call.callback)
            this.once('response', call.callback);
        if (call.timeoutMs !== null)
            this.setTimeout(call.timeoutMs);
        if (call.signal) {
            if (call.signal.aborted)
                queueMicrotask(() => this.abort());
            else
                call.signal.addEventListener('abort', () => this.abort(), { once: true });
        }
    }
    get headersSent() { return this.writableEnded; }
    setHeader(name, value) {
        this.headerMap.set(name, Array.isArray(value) ? value.join(', ') : String(value));
        return this;
    }
    getHeader(name) { return this.headerMap.get(name) ?? undefined; }
    getHeaders() { return Object.fromEntries(this.headerMap.entries()); }
    getHeaderNames() { return [...this.headerMap.keys()]; }
    hasHeader(name) { return this.headerMap.has(name); }
    removeHeader(name) { this.headerMap.delete(name); }
    /** The request's headers as they would be sent, including later `setHeader` calls. */
    currentHeaders() { return new Headers(this.headerMap); }
    setTimeout(ms, callback) {
        if (callback)
            this.once('timeout', callback);
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = ms > 0 ? setTimeout(() => this.emit('timeout'), ms) : null;
        this.timer?.unref?.();
        return this;
    }
    setNoDelay() { }
    setSocketKeepAlive() { }
    flushHeaders() { }
    abort() {
        if (this.aborted)
            return;
        this.aborted = true;
        this.emit('abort');
        this.destroy();
    }
    _write(chunk, encoding, done) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        done();
    }
    _final(done) {
        done();
        void this.resolve();
    }
    _destroy(error, done) {
        this.controller.abort();
        if (this.timer)
            clearTimeout(this.timer);
        done(error);
    }
    async resolve() {
        try {
            const response = await this.respond(Buffer.concat(this.chunks), this.controller.signal);
            const body = Buffer.from(await response.arrayBuffer());
            if (this.destroyed)
                return;
            if (this.timer)
                clearTimeout(this.timer);
            const message = incomingFrom(response, body, this);
            message.once('end', () => this.destroy());
            this.emit('response', message);
        }
        catch (error) {
            if (!this.destroyed)
                this.destroy(error instanceof Error ? error : new Error(String(error)));
        }
    }
}
exports.MockedClientRequest = MockedClientRequest;
/** A readable that carries the fields clients read from an `IncomingMessage`. */
function incomingFrom(response, body, request) {
    const message = new node_stream_1.PassThrough();
    const headers = {};
    const rawHeaders = [];
    response.headers.forEach((value, name) => {
        if (name === 'set-cookie')
            return;
        headers[name] = value;
        rawHeaders.push(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
        headers['set-cookie'] = cookies;
        for (const cookie of cookies)
            rawHeaders.push('set-cookie', cookie);
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
    return message;
}
//# sourceMappingURL=outgoing.js.map