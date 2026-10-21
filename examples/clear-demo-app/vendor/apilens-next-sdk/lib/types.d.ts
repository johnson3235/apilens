/**
 * Wire types shared between the server SDK and the ApiLens browser extension.
 *
 * This file must stay dependency-free: the Next SDK ships as a standalone
 * tarball, so it cannot import `@apilens/shared-types`. The extension keeps a
 * structurally identical copy in `shared/server-control.ts`; changing a field
 * here means changing it there too.
 */
export declare const CONTROL_PROTOCOL_VERSION = 2;
/** How a captured body was encoded for transport. */
export type BodyEncoding = 'utf8' | 'base64';
/** A captured request or response payload, always bounded and redacted. */
export interface CapturedBody {
    content: string;
    encoding: BodyEncoding;
    contentType: string | null;
    /** Bytes actually captured, which is `<= maxBodyBytes`. */
    byteLength: number;
    /** True when the payload was longer than the configured cap. */
    truncated: boolean;
    /** True when at least one value was replaced by the redactor. */
    redacted: boolean;
}
/**
 * A single server-side call.
 *
 * `kind: 'server'` is an incoming App Router request, `kind: 'client'` is an
 * outgoing fetch made while handling one.
 */
export interface ServerCall {
    /** Monotonic per-process cursor so the extension can poll incrementally. */
    seq: number;
    spanId: string;
    traceId: string;
    parentSpanId: string | null;
    sessionId: string;
    scenarioId: string | null;
    serviceName: string;
    kind: 'server' | 'client';
    method: string;
    /** Origin + path. Query values are reported separately and redacted. */
    url: string;
    origin: string;
    path: string;
    query: Record<string, string>;
    statusCode: number | null;
    status: 'ok' | 'error';
    startedAt: number;
    endedAt: number;
    durationMs: number;
    /** Milliseconds until the response body finished, when bodies are captured. */
    bodyDurationMs: number | null;
    requestHeaders: Record<string, string>;
    responseHeaders: Record<string, string>;
    requestBody: CapturedBody | null;
    responseBody: CapturedBody | null;
    /** Why a body is absent, for UI transparency (`null` when one was captured). */
    requestBodyOmitted: string | null;
    responseBodyOmitted: string | null;
    error: string | null;
    /** Name of the server mock rule that produced this response, when any. */
    mockedBy: string | null;
}
export type MockMatchType = 'glob' | 'regex' | 'contains' | 'equals' | 'startsWith';
export interface ServerMockMatch {
    /** `ANY` matches every verb. */
    method: string;
    urlPattern: string;
    matchType: MockMatchType;
    /** Restrict to outgoing fetch, incoming routes, or both. */
    kind: 'client' | 'server' | 'any';
    /** Optional substring the request body must contain. */
    bodyContains?: string;
    /** Optional request header that must be present, and optionally equal a value. */
    headerName?: string;
    headerValue?: string;
    /** Only apply while this QA session is active. Empty means any session. */
    sessionId?: string | null;
}
export type ServerMockActionType = 'status-code' | 'custom-body' | 'empty-response' | 'invalid-json' | 'network-error' | 'timeout' | 'passthrough-mutate';
export type MutationOperation = 'set' | 'delete' | 'nullify' | 'changeType';
export interface ServerFieldMutation {
    /** Dotted/bracket path, for example `data.items[0].amountDue`. */
    path: string;
    operation: MutationOperation;
    value?: unknown;
    targetType?: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
}
export interface ServerMockAction {
    type: ServerMockActionType;
    statusCode?: number;
    statusText?: string;
    /** Replacement body for `custom-body`/`status-code`. */
    body?: string;
    headers?: Record<string, string>;
    /** Latency added before the response is produced. */
    delayMs?: number;
    /** Applied to the real JSON response for `passthrough-mutate`. */
    fieldMutations?: ServerFieldMutation[];
}
export type ServerMockApplyMode = 'always' | 'once' | 'n-times' | 'after-n';
export interface ServerMockRule {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    /** Lower number wins. */
    priority: number;
    match: ServerMockMatch;
    action: ServerMockAction;
    applyMode: ServerMockApplyMode;
    applyLimit?: number;
    appliedCount: number;
    createdAt: number;
    updatedAt: number;
}
/** Why a rule did not fire, so "my mock did nothing" is never a mystery. */
export interface MockSkipReason {
    ruleId: string;
    ruleName: string;
    reason: string;
}
export interface ControlHealth {
    ok: true;
    protocolVersion: number;
    sdkVersion: string;
    serviceName: string;
    /** Distinguishes a restarted server from an idle one. */
    processId: string;
    startedAt: number;
    enabled: boolean;
    captureRequestBodies: boolean;
    captureResponseBodies: boolean;
    maxBodyBytes: number;
    mockingEnabled: boolean;
    routeMocksEnabled: boolean;
    bufferedCalls: number;
    /** Highest `seq` currently buffered. */
    latestSeq: number;
    droppedCalls: number;
    ruleCount: number;
    activeRuleCount: number;
    agentDelivery: {
        accepted: number;
        dropped: number;
        lastError: string | null;
    };
}
export interface ControlCallsResponse {
    processId: string;
    latestSeq: number;
    calls: ServerCall[];
    /** True when the buffer rolled over and some calls between cursors were lost. */
    gap: boolean;
}
export interface ControlRulesResponse {
    processId: string;
    rules: ServerMockRule[];
    revision: string;
}
/** Controls whether request/response payloads are recorded. */
export interface BodyCaptureOptions {
    request?: boolean;
    response?: boolean;
    /** Hard cap per payload. Larger payloads are truncated, never dropped silently. */
    maxBytes?: number;
    /**
     * Content types eligible for capture. Anything else is reported as omitted
     * rather than buffered, which keeps binary downloads out of memory.
     */
    contentTypes?: string[];
    /** Extra object keys whose values are replaced with `[REDACTED]`. */
    redactKeys?: string[];
    /** Capture bodies of binary content types as base64. Default false. */
    includeBinary?: boolean;
}
export interface ControlPlaneOptions {
    /** Must be explicitly true; the control plane is never on by default. */
    enabled: boolean;
    /** Minimum 24 characters. Never reuse the agent token in a public deployment. */
    token: string;
    /**
     * Origins allowed to call the control plane from a browser page context.
     * Extension requests carry no page origin and are authorised by token only.
     */
    allowedOrigins?: string[];
    /** Calls retained in the ring buffer. Default 500. */
    bufferSize?: number;
    /** Allow the extension to push mock rules. Default true. */
    allowMockControl?: boolean;
    /**
     * For serverless hosts such as Vercel, which run pages and API routes as
     * separate functions with separate memory. When set, a process that has not
     * served the extension itself forwards the calls it captures to the app's
     * control endpoint and reads the server mock rules from there, so the panel
     * sees one consistent picture. Leave unset on a single Node server.
     *
     * `url` defaults to `<origin of the current request>/api/__apilens`;
     * `headers` are added to relay requests (e.g. a deployment-protection bypass).
     */
    relay?: {
        url?: string;
        headers?: Record<string, string>;
        timeoutMs?: number;
    };
}
export interface NextSDKOptions {
    serviceName: string;
    /** Explicit opt-in on a controlled Node-runtime QA deployment. Default false. */
    enabled?: boolean;
    agentUrl?: string;
    /**
     * Server-only secret for the loopback agent. Required only when
     * `reportToAgent` is left enabled.
     */
    agentToken?: string;
    /**
     * Push spans to a loopback ApiLens agent. Turn this off on a remote dev
     * server, where `127.0.0.1` is not the tester's machine, and use the
     * control plane instead. Defaults to true when `agentToken` is present.
     */
    reportToAgent?: boolean;
    /** Exact application origins eligible for incoming QA context. */
    allowedAppOrigins: string[];
    /** Optional trusted downstream origins receiving correlation headers. Default none. */
    propagateToOrigins?: string[];
    /**
     * Capture server calls even when the request carries no QA session header.
     * Required to see traffic on a shared dev deployment where the tester cannot
     * set headers, and scoped to `allowedAppOrigins`. Default false.
     */
    captureWithoutSession?: boolean;
    captureBodies?: BodyCaptureOptions;
    /** Serve the in-app control endpoint the extension talks to. */
    control?: ControlPlaneOptions;
    /** Allow mock rules to short-circuit incoming route handlers. Default false. */
    allowRouteMocks?: boolean;
}
//# sourceMappingURL=types.d.ts.map