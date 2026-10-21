"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallBuffer = void 0;
/**
 * Bounded ring buffer of captured server calls.
 *
 * The extension polls with a cursor rather than holding a socket open, which
 * survives serverless cold starts, proxies and VPNs. A monotonic `seq` makes
 * polling incremental, and a dropped-count makes buffer rollover visible
 * instead of silently losing calls.
 */
class CallBuffer {
    capacity;
    calls = [];
    nextSeq = 1;
    dropped = 0;
    constructor(capacity) {
        this.capacity = capacity;
    }
    add(call) {
        const stored = { ...call, seq: this.nextSeq };
        this.nextSeq += 1;
        this.calls.push(stored);
        while (this.calls.length > this.capacity) {
            this.calls.shift();
            this.dropped += 1;
        }
        return stored;
    }
    /**
     * Returns calls newer than `since`.
     *
     * `gap` is true when the cursor points at calls already evicted, so the UI
     * can say "older calls were dropped" rather than pretending none existed.
     */
    since(cursor, limit) {
        const oldest = this.calls[0]?.seq ?? this.nextSeq;
        const gap = cursor > 0 && cursor + 1 < oldest;
        const matching = this.calls.filter((call) => call.seq > cursor);
        return { calls: matching.slice(0, Math.max(1, limit)), gap };
    }
    all() {
        return [...this.calls];
    }
    latestSeq() {
        return this.nextSeq - 1;
    }
    size() {
        return this.calls.length;
    }
    droppedCount() {
        return this.dropped;
    }
    clear() {
        this.calls.length = 0;
        this.dropped = 0;
    }
}
exports.CallBuffer = CallBuffer;
//# sourceMappingURL=buffer.js.map