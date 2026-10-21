import type { MockSkipReason, ServerFieldMutation, ServerMockRule } from './types';
export interface MockCandidate {
    kind: 'client' | 'server';
    method: string;
    url: string;
    headers: Headers;
    /** Already-captured request text, when available. */
    bodyText: string | null;
    sessionId: string;
}
export interface MockDecision {
    rule: ServerMockRule | null;
    skipped: MockSkipReason[];
}
export declare function selectMockRule(rules: ServerMockRule[], candidate: MockCandidate): MockDecision;
export declare function applyFieldMutations(text: string, mutations: ServerFieldMutation[]): string;
export declare function delay(ms: number, signal?: AbortSignal | null): Promise<void>;
/** Thrown to reproduce a transport-level failure a status code cannot express. */
export declare class MockNetworkError extends TypeError {
    readonly ruleName: string;
    constructor(message: string, ruleName: string);
}
/**
 * Makes a value safe for an HTTP header.
 *
 * Rule names are user-supplied and routinely contain characters like `→`,
 * which throw when assigned to a header. A mock must never crash the request
 * it is decorating.
 */
export declare function headerSafe(value: string): string;
/**
 * Builds the synthetic response for a matched rule.
 *
 * `passthrough-mutate` is handled by the caller because it needs the real
 * upstream response; everything else is produced without a network call.
 */
export declare function buildMockResponse(rule: ServerMockRule, signal: AbortSignal | null | undefined): Promise<Response>;
/** Normalises a rule that arrived over the control plane. */
export declare function sanitizeRule(input: unknown, now: number): ServerMockRule | null;
//# sourceMappingURL=mocks.d.ts.map