import type { ServerCall } from './types';

/**
 * Bounded ring buffer of captured server calls.
 *
 * The extension polls with a cursor rather than holding a socket open, which
 * survives serverless cold starts, proxies and VPNs. A monotonic `seq` makes
 * polling incremental, and a dropped-count makes buffer rollover visible
 * instead of silently losing calls.
 */
export class CallBuffer {
  private readonly calls: ServerCall[] = [];
  private nextSeq = 1;
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  add(call: Omit<ServerCall, 'seq'>): ServerCall {
    const stored: ServerCall = { ...call, seq: this.nextSeq };
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
  since(cursor: number, limit: number): { calls: ServerCall[]; gap: boolean } {
    const oldest = this.calls[0]?.seq ?? this.nextSeq;
    const gap = cursor > 0 && cursor + 1 < oldest;
    const matching = this.calls.filter((call) => call.seq > cursor);
    return { calls: matching.slice(0, Math.max(1, limit)), gap };
  }

  all(): ServerCall[] {
    return [...this.calls];
  }

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  size(): number {
    return this.calls.length;
  }

  droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.calls.length = 0;
    this.dropped = 0;
  }
}
