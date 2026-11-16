import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { BodyCaptureOptions, RelayStatus } from './types';
/**
 * The ApiLens relay: a small forwarding proxy for a backend you cannot (or
 * would rather not) instrument, such as a Spring service calling TMF APIs.
 *
 * The backend's upstream base URLs are pointed at the relay
 * (`http://apilens-relay/tmf622` instead of `https://tmf622.internal`), and
 * the relay forwards every request unchanged. Requests that carry a QA
 * session (`x-qa-session-id`, propagated from the BFF) are also recorded and
 * delivered to the app's control plane, where the extension shows them under
 * the page that caused them, and can be answered by a server mock instead.
 *
 * On a shared environment (the default) a request without a QA session is
 * piped straight through: never buffered, recorded or mocked. Other squads'
 * traffic sees a plain proxy.
 */
export interface RelayRoute {
    /** First path segment the backend calls, such as `tmf622`. Shown in the extension. */
    name: string;
    /** Where that traffic really goes: origin plus optional base path. */
    target: string;
    /**
     * Who calls this route, when not `callerName`: `tmf` for an OSB route the
     * TMF services use. The extension nests a call under the hop whose route
     * starts with this name, so OSB calls appear under the TMF call that made them.
     */
    caller?: string;
}
export interface RelayOptions {
    /** `[{ name: 'tmf622', target: 'https://tmf622.dev.internal' }]` or `{ tmf622: 'https://…' }`. */
    routes: RelayRoute[] | Record<string, string>;
    /** The app's control plane, the same one the extension connects to. */
    control: {
        /** For example `https://clear-dev.example.com/api/__apilens`. */
        url: string;
        token: string;
        timeoutMs?: number;
        headers?: Record<string, string>;
    };
    /** Identifies this relay in the extension. Default `apilens-relay`. */
    name?: string;
    /** The service whose calls pass through, recorded as the caller. Default `backend`. */
    callerName?: string;
    /**
     * Default true: traffic without a QA session is forwarded untouched and never
     * recorded or mocked. False records it under the ambient session and lets
     * rules without a session apply to it; only for an environment you own.
     */
    sharedEnvironment?: boolean;
    captureBodies?: BodyCaptureOptions;
    /** Largest request body buffered for a recorded call. Default 8 MB. */
    maxRequestBytes?: number;
    /** How often mock rules are refreshed from the control plane. Default 2 s. */
    rulesIntervalMs?: number;
    /** How often recorded calls are delivered. Default 250 ms. */
    flushIntervalMs?: number;
    /** Status sent when there is nothing to deliver, so the extension knows the relay is alive. Default 15 s. */
    heartbeatMs?: number;
    /** Calls held while the control plane is unreachable before the oldest are dropped. Default 1000. */
    maxQueue?: number;
    log?: (line: string) => void;
}
/** `x-qa-session-id` as a header, or as a W3C baggage entry (OpenTelemetry propagates baggage by default). */
export declare function sessionFromHeaders(req: IncomingMessage): string | undefined;
/** The caller's trace: W3C first, then B3. */
export declare function traceFromHeaders(req: IncomingMessage): {
    traceId: string;
    spanId: string;
} | null;
interface ResolvedRoute {
    base: URL;
    caller: string | null;
}
export declare function normaliseRoutes(routes: RelayOptions['routes']): Map<string, ResolvedRoute>;
/** Applies `osb=tmf,vesta=tmf` (APILENS_RELAY_CALLERS) to parsed routes. */
export declare function withCallers(routes: Record<string, string>, callers: string | undefined): RelayRoute[];
/** Parses `tmf622=https://a,tmf629=https://b` (commas or newlines). */
export declare function parseRoutesEnv(value: string | undefined): Record<string, string>;
export declare class ApiLensRelay {
    private readonly options;
    private readonly routes;
    private readonly controlUrl;
    private readonly bodyConfig;
    private readonly shared;
    private readonly name;
    private readonly caller;
    private readonly maxRequestBytes;
    private readonly maxQueue;
    private readonly log;
    private readonly agents;
    private rules;
    private queue;
    private flushing;
    private lastDelivery;
    private timers;
    private server;
    private lastControlError;
    private readonly failing;
    /** Calls whose response is still on its way, so flush() can wait for them. */
    private readonly open;
    private readonly stats;
    constructor(options: RelayOptions);
    status(): Omit<RelayStatus, 'lastSeenAt'>;
    get lastError(): string | null;
    /** Starts listening and the background rule refresh and delivery. */
    listen(port: number, host?: string): Promise<http.Server>;
    /** Background work only, for tests or when mounting `handle` on your own server. */
    start(): void;
    close(): Promise<void>;
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
    private pending;
    private transport;
    private upstreamFailed;
    /** Streams the request and response through untouched; records afterwards when `pending` is given. */
    private pipe;
    private forward;
    private serveMock;
    /** The backend hung up (usually its own client timeout) before the answer arrived. */
    private abandoned;
    private applied;
    private record;
    /** Delivers queued calls, with this relay's status, to the control plane. */
    flush(): Promise<void>;
    refreshRules(): Promise<void>;
    private control;
}
export declare function createRelay(options: RelayOptions): ApiLensRelay;
export {};
//# sourceMappingURL=relay.d.ts.map