"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallBuffer = exports.DEFAULT_MAX_BUFFER_BYTES = void 0;
exports.estimateCallBytes = estimateCallBytes;
/** Default memory ceiling for buffered calls. */
exports.DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/** Fixed per-call overhead for metadata, headers and object bookkeeping. */
const CALL_OVERHEAD_BYTES = 2_048;
/** Rough in-memory size of a call: JS strings are UTF-16, so two bytes a character. */
function estimateCallBytes(call) {
    let size = CALL_OVERHEAD_BYTES + call.url.length * 2;
    for (const body of [call.requestBody, call.responseBody])
        if (body)
            size += body.content.length * 2;
    for (const headers of [call.requestHeaders, call.responseHeaders]) {
        for (const [name, value] of Object.entries(headers))
            size += (name.length + value.length) * 2;
    }
    return size;
}
/**
 * Bounded ring buffer of captured server calls.
 *
 * The extension polls with a cursor rather than holding a socket open, which
 * survives serverless cold starts, proxies and VPNs. A monotonic `seq` makes
 * polling incremental, and a dropped-count makes buffer rollover visible
 * instead of silently losing calls. Both a call count and a byte budget bound
 * it, whichever is reached first.
 */
class CallBuffer {
    capacity;
    maxBytes;
    calls = [];
    sizes = [];
    bytes = 0;
    nextSeq = 1;
    dropped = 0;
    constructor(capacity, maxBytes = exports.DEFAULT_MAX_BUFFER_BYTES) {
        this.capacity = capacity;
        this.maxBytes = maxBytes;
    }
    add(call) {
        const stored = { ...call, seq: this.nextSeq };
        const size = estimateCallBytes(call);
        this.nextSeq += 1;
        this.calls.push(stored);
        this.sizes.push(size);
        this.bytes += size;
        // The newest call always stays, even if it alone exceeds the budget.
        while (this.calls.length > 1 && (this.calls.length > this.capacity || this.bytes > this.maxBytes)) {
            this.calls.shift();
            this.bytes -= this.sizes.shift() ?? 0;
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
    byteSize() {
        return this.bytes;
    }
    byteLimit() {
        return this.maxBytes;
    }
    droppedCount() {
        return this.dropped;
    }
    clear() {
        this.calls.length = 0;
        this.sizes.length = 0;
        this.bytes = 0;
        this.dropped = 0;
    }
}
exports.CallBuffer = CallBuffer;
//# sourceMappingURL=buffer.js.map