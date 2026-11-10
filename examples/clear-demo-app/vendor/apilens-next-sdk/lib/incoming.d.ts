import { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type OutgoingMessage, type ServerResponse } from 'node:http';
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
export declare function setRequestHook(hook: RequestHook): void;
/** Detaches `hook` if it is still the active one; the patch itself stays inert. */
export declare function clearRequestHook(hook: RequestHook): void;
export declare function nodeHeaders(raw: IncomingHttpHeaders | OutgoingHttpHeaders): Headers;
/**
 * Response headers as sent. Headers passed straight to `writeHead` never
 * reach `getHeaders()`, so they are recorded on the way through.
 */
export declare function trackResponseHeaders(res: ServerResponse): () => Headers;
/** Bounded copy of the chunks a stream carries; the stream itself is untouched. */
export declare class BodyTap {
    private readonly cap;
    private chunks;
    size: number;
    truncated: boolean;
    constructor(cap: number);
    add(chunk: unknown, encoding?: unknown): void;
    bytes(): Buffer;
}
/**
 * Copies an incoming body as Node's parser pushes it.
 *
 * Listening for `data` would switch the stream to flowing mode and steal the
 * body from the application, so the copy is taken at `push` instead.
 */
export declare function tapRequest(req: IncomingMessage, cap: number): BodyTap;
/** Copies what the application writes to an outgoing message (a server response or a client request). */
export declare function tapWrites(message: OutgoingMessage, cap: number): BodyTap;
/**
 * Undoes transfer compression (`next start` gzips by default) on a possibly
 * truncated capture. Returns null when the encoding is unknown or corrupt.
 */
export declare function decodeBody(bytes: Buffer, contentEncoding: string | null, cap: number): Buffer | null;
//# sourceMappingURL=incoming.d.ts.map