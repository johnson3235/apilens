import type { CallBuffer } from './buffer';
import type { ControlHealth, ControlPlaneOptions, ServerMockRule } from './types';
/**
 * The in-app control plane.
 *
 * A loopback agent cannot be reached from a remote dev deployment, so the
 * application itself exposes an authenticated, non-indexable endpoint that the
 * extension polls over the same HTTPS origin the tester already uses.
 *
 * Everything here assumes hostile input: the endpoint is reachable by anyone
 * who can reach the app, so the token is the only thing standing between a
 * caller and captured traffic.
 */
export declare const MIN_TOKEN_LENGTH = 24;
export interface ControlContext {
    options: ControlPlaneOptions;
    processId: string;
    buffer: CallBuffer;
    health: () => ControlHealth;
    getRules: () => ServerMockRule[];
    setRules: (rules: ServerMockRule[]) => void;
    rulesRevision: () => string;
    clearCalls: () => void;
    /** Stores calls relayed by another process of the same app; returns how many were kept. */
    ingest: (calls: unknown[]) => number;
    /** Counts rule applications that happened in another process, so apply budgets hold. */
    consume: (ruleIds: string[]) => void;
}
/** Most calls accepted in one relay request. */
export declare const MAX_RELAY_BATCH = 50;
export declare function isTokenAcceptable(token: string | undefined): boolean;
/** Epoch milliseconds after which the control plane stops answering, or null for no expiry. */
export declare function parseExpiry(value: string | number | undefined): number | null;
/** Normalised control mount, e.g. `/api/__apilens`, without a trailing slash. */
export declare function controlMountPath(value: string | undefined): string;
/**
 * Resolves the operation from the request path.
 *
 * The handler is mounted on a catch-all route, so only the trailing segment is
 * meaningful and the mount prefix stays the integrator's choice.
 */
export declare function resolveOperation(pathname: string): string;
export declare function createControlHandler(context: ControlContext): (request: Request) => Promise<Response>;
/** This process's entry in `cursors=<processId>:<seq>,…`; 0 when the extension has not polled it yet. */
export declare function cursorFor(cursors: string, processId: string): number;
export declare function buildRulesRevision(rules: ServerMockRule[]): string;
export declare function emptyHealth(serviceName: string, processId: string, startedAt: number, sdkVersion: string): ControlHealth;
//# sourceMappingURL=control.d.ts.map