import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
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
/** The real `http.request`, for the SDK's own traffic, which must never be captured. */
export declare function unpatchedHttpRequest(): typeof http.request;
export declare function setOutgoingHook(hook: OutgoingHook): void;
export declare function clearOutgoingHook(hook: OutgoingHook): void;
/** Error shapes HTTP clients recognise (axios, got, etc. read `code`). */
export declare function simulatedConnectionError(ruleName: string): Error;
/**
 * Performs the real request and buffers the whole response as a `Response`,
 * decompressed. Used when a mock needs the real answer first.
 */
export declare function realResponse(original: RequestFn, call: OutgoingCall, body: Buffer, signal: AbortSignal): Promise<Response>;
/**
 * Stands in for a `ClientRequest` whose answer comes from a mock rule.
 *
 * It accepts writes and piping like the real thing, honours `setTimeout`,
 * `abort`/`destroy` and an `AbortSignal`, then emits a `response` that reads
 * like an `IncomingMessage`, or an `error` for simulated network failures.
 */
export declare class MockedClientRequest extends Writable {
    private readonly respond;
    readonly method: string;
    readonly path: string;
    readonly host: string;
    readonly protocol: string;
    readonly reusedSocket = false;
    aborted: boolean;
    private readonly headerMap;
    private readonly chunks;
    private readonly controller;
    private timer;
    constructor(call: OutgoingCall, respond: (body: Buffer, signal: AbortSignal) => Promise<Response>);
    get headersSent(): boolean;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | undefined;
    getHeaders(): Record<string, string>;
    getHeaderNames(): string[];
    hasHeader(name: string): boolean;
    removeHeader(name: string): void;
    /** The request's headers as they would be sent, including later `setHeader` calls. */
    currentHeaders(): Headers;
    setTimeout(ms: number, callback?: () => void): this;
    setNoDelay(): void;
    setSocketKeepAlive(): void;
    flushHeaders(): void;
    abort(): void;
    _write(chunk: Buffer | string, encoding: BufferEncoding, done: (error?: Error | null) => void): void;
    _final(done: (error?: Error | null) => void): void;
    _destroy(error: Error | null, done: (error?: Error | null) => void): void;
    private resolve;
}
export {};
//# sourceMappingURL=outgoing.d.ts.map