import type { ControlHealth, NextSDKOptions, ServerCall, ServerMockRule } from './types';
export * from './types';
export { DEFAULT_TEXT_CONTENT_TYPES } from './bodies';
export { MIN_TOKEN_LENGTH } from './control';
export declare const SDK_VERSION = "0.2.0";
/**
 * Session id used when `captureWithoutSession` is on.
 *
 * A shared dev deployment serves testers who cannot inject headers, so their
 * traffic is grouped here rather than discarded.
 */
export declare const AMBIENT_SESSION_ID = "apilens-ambient";
/** Wire-compatible with ApiLens TraceSpan; no workspace runtime/type dependencies. */
export interface ServerSpan {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    sessionId: string;
    serviceName: string;
    operationName: string;
    kind: 'server' | 'client';
    source: 'internal-service';
    channel: 'server-sdk';
    method: string;
    url: string;
    statusCode: number | null;
    status: 'ok' | 'error';
    startedAt: number;
    endedAt: number;
    durationMs: number;
    attributes: Record<string, string | number | boolean>;
    events: never[];
    error: string | null;
    mockedBy: string | null;
}
export declare function safeHeaders(headers: Headers): Record<string, string>;
export declare class ApiLensNextSDK {
    private readonly options;
    private readonly contexts;
    private readonly insideFetch;
    private readonly reporter;
    private readonly buffer;
    private readonly bodyCapture;
    private readonly control;
    private wrapper;
    private downstream;
    private stopped;
    private readonly allowed;
    private readonly allowAnyOrigin;
    private readonly propagate;
    private rules;
    private rulesRev;
    /** Recording runs off the request's critical path; `flush()` drains it. */
    private readonly pendingRecords;
    /** Set once this process answers the extension: from then on it keeps calls itself. */
    private servedControl;
    private relayFailures;
    private lastRelayError;
    /** Distinguishes a restarted server from an idle one in the extension. */
    readonly processId: string;
    readonly startedAt: number;
    constructor(options: NextSDKOptions);
    get diagnostics(): {
        relayFailures: number;
        lastRelayError: string | null;
        accepted: number;
        dropped: number;
        lastError: string | null;
    };
    get enabled(): boolean;
    /** True when the extension can reach this process over the control plane. */
    get controlEnabled(): boolean;
    health(): ControlHealth;
    /** Calls captured so far, newest last. Useful for assertions in automated tests. */
    calls(): ServerCall[];
    clearCalls(): void;
    serverMockRules(): ServerMockRule[];
    /** Replaces the active server mock rules, normalising anything untrusted. */
    setServerMockRules(rules: unknown[]): ServerMockRule[];
    private applyRules;
    /**
     * Handles one control-plane request.
     *
     * Mount from a catch-all Node-runtime route such as
     * `src/app/api/%5F_apilens/[[...segments]]/route.ts` (served at `/api/__apilens`;
     * a folder starting with `_` is private in the App Router and never routed).
     */
    handleControlRequest(request: Request): Promise<Response>;
    /** Ready-made App Router exports for the control route file. */
    controlRoute(): {
        GET: (request: Request) => Promise<Response>;
        POST: (request: Request) => Promise<Response>;
        PUT: (request: Request) => Promise<Response>;
        DELETE: (request: Request) => Promise<Response>;
        OPTIONS: (request: Request) => Promise<Response>;
    };
    /** Call from instrumentation.ts register(), and once per route to tolerate Next's fetch patching. */
    installFetch(): void;
    private instrumentedFetch;
    /** Preserves NextRequest and params context. */
    wrapRoute<R extends Request, C>(handler: (request: R, context: C) => Response | Promise<Response>): (request: R, context: C) => Promise<Response>;
    /**
     * Captures server-side rendering work as a page call.
     *
     * Server Components, `generateMetadata` and server actions have no Request
     * for `wrapRoute` to wrap, so the backend fetches they make would otherwise
     * go uncaptured — and the browser never sees them either. Run the data
     * loading inside `traceRender` and each fetch becomes a backend call under
     * one page call:
     *
     *   const data = await apiLens.traceRender(
     *     { path: `/myaccount/billing?contactId=${id}`, headers: headers() },
     *     () => loadBilling(id),
     *   );
     *
     * `headers` (from `next/headers`) supplies the host, the QA session and the
     * incoming trace. A plain-object or array result is captured as the page
     * call's "Received" body. Next's redirect/notFound signals are recorded as
     * 307/404, not failures. Server mocks apply to the backend calls inside;
     * the render itself is never mocked.
     */
    traceRender<T>(page: string | {
        path: string;
        method?: string;
        headers?: Headers | null;
    }, render: () => T | Promise<T>): Promise<T>;
    /**
     * Wraps every HTTP export of a route module at once.
     *
     * Hand-wrapping dozens of routes is where instrumentation coverage silently
     * goes missing, so this keeps a route file to a single line.
     */
    wrapRouteModule<T extends Record<string, unknown>>(handlers: T): T;
    private originAllowed;
    private decide;
    private serveMock;
    /**
     * Rewrites a real upstream response for a `passthrough-mutate` rule.
     *
     * Reads the real body, applies the mutations and hands back a fresh
     * Response; on any failure the untouched original is returned so a broken
     * rule can never break the application.
     */
    private mutatePassthrough;
    private track;
    private finishRecord;
    /**
     * Where this process should forward captures, or null to keep them.
     *
     * Only processes that have not answered the extension relay: on Vercel the
     * API function hosting the control route becomes the store, and page
     * functions forward to it.
     */
    private relayTarget;
    private relayRequest;
    private relayPost;
    /** Refreshes the mock rules from the relay target; keeps the last copy if it cannot. */
    private pullRules;
    private ingestRelayed;
    /** Drains pending captures, then delivers queued spans to the agent. */
    flush(): Promise<void>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map