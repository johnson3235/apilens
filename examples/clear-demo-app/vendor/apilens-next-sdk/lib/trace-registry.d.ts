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
export declare function traceKey(traceId: string): string | null;
export declare class TraceRegistry {
    private readonly ttlMs;
    private readonly max;
    private readonly owners;
    constructor(ttlMs?: number, max?: number);
    register(traceId: string, sessionId: string, scenarioId: string | null | undefined): void;
    lookup(traceId: string): TraceOwner | null;
    /** Traces registered in the last `withinMs`, newest first, at most `limit`. */
    recent(withinMs: number, limit?: number): TraceOwner[];
}
//# sourceMappingURL=trace-registry.d.ts.map