import type { ServerCall } from './types';
/**
 * Bounded ring buffer of captured server calls.
 *
 * The extension polls with a cursor rather than holding a socket open, which
 * survives serverless cold starts, proxies and VPNs. A monotonic `seq` makes
 * polling incremental, and a dropped-count makes buffer rollover visible
 * instead of silently losing calls.
 */
export declare class CallBuffer {
    private readonly capacity;
    private readonly calls;
    private nextSeq;
    private dropped;
    constructor(capacity: number);
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
    droppedCount(): number;
    clear(): void;
}
//# sourceMappingURL=buffer.d.ts.map