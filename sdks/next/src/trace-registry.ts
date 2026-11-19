/**
 * Which QA session each propagated trace belongs to.
 *
 * When the SDK passes a tester's request on to a backend (an origin in
 * `propagateToOrigins`) it remembers the trace it sent. A backend that
 * continues the trace (OpenTelemetry, Datadog, Brave, …) but drops the
 * `x-qa-session-id` header still carries that trace id to the services it
 * calls, so an ApiLens relay in front of them can ask "whose trace is this?"
 * and record or mock the call for the right tester.
 *
 * Keyed by the low 64 bits of the trace id: Datadog and 64-bit B3 headers only
 * carry those, and they are random either way.
 */

export interface TraceOwner {
  /** The full 32-hex trace id, so a relay can nest the call under the page even from a 64-bit header. */
  traceId: string;
  sessionId: string;
  scenarioId: string | null;
  at: number;
}

/** The low 64 bits, as 16 lowercase hex, of a 16- or 32-hex trace id; null for anything else. */
export function traceKey(traceId: string): string | null {
  const value = traceId.trim().toLowerCase();
  if (!/^([\da-f]{16}|[\da-f]{32})$/.test(value)) return null;
  const key = value.slice(-16);
  return /^0+$/.test(key) ? null : key;
}

export class TraceRegistry {
  private readonly owners = new Map<string, TraceOwner>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly max = 5_000) {}

  register(traceId: string, sessionId: string, scenarioId: string | null | undefined): void {
    const key = traceKey(traceId);
    if (!key) return;
    // Re-inserted so the map stays ordered oldest first.
    this.owners.delete(key);
    this.owners.set(key, { traceId: traceId.toLowerCase(), sessionId, scenarioId: scenarioId ?? null, at: Date.now() });
    while (this.owners.size > this.max) this.owners.delete(this.owners.keys().next().value as string);
  }

  lookup(traceId: string): TraceOwner | null {
    const key = traceKey(traceId);
    const owner = key ? this.owners.get(key) : undefined;
    if (!owner) return null;
    if (Date.now() - owner.at > this.ttlMs) {
      this.owners.delete(key!);
      return null;
    }
    return owner;
  }

  /** Traces registered in the last `withinMs`, newest first, at most `limit`. */
  recent(withinMs: number, limit = 200): TraceOwner[] {
    const cutoff = Date.now() - withinMs;
    const result: TraceOwner[] = [];
    for (const owner of [...this.owners.values()].reverse()) {
      if (owner.at < cutoff || result.length >= limit) break;
      result.push(owner);
    }
    return result;
  }
}
