import type { ServerCall } from './types';
/** Default memory ceiling for buffered calls. */
export declare const DEFAULT_MAX_BUFFER_BYTES: number;
/** Rough in-memory size of a call: JS strings are UTF-16, so two bytes a character. */
export declare function estimateCallBytes(call: Omit<ServerCall, 'seq'>): number;
/**
 * Bounded ring buffer of captured server calls.
 *
 * The extension polls with a cursor rather than holding a socket open, which
 * survives serverless cold starts, proxies and VPNs. A monotonic `seq` makes
 * polling incremental, and a dropped-count makes buffer rollover visible
 * instead of silently losing calls. Both a call count and a byte budget bound
 * it, whichever is reached first.
 */
export declare class CallBuffer {
    private readonly capacity;
    private readonly maxBytes;
    private readonly calls;
    private readonly sizes;
    private bytes;
    private nextSeq;
    private dropped;
    constructor(capacity: number, maxBytes?: number);
    add(call: Omit<ServerCall, 'seq'>): ServerCall;
    /**
     * Returns calls newer than `since`.
     *
     * `gap` is true when the cursor points at calls already evicted, so the UI
     * can say "older calls were dropped" rather than pretending none existed.
     */
    since(cursor: number, limit: number): {
        calls: ServerCall[];
        gap: boolean;
    };
    all(): ServerCall[];
    latestSeq(): number;
    size(): number;
    byteSize(): number;
    byteLimit(): number;
    droppedCount(): number;
    clear(): void;
}
//# sourceMappingURL=buffer.d.ts.map