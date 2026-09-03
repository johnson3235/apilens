/**
 * Provenance describes *how* a request became visible to ApiLens.
 *
 * This is deliberately explicit: a browser extension cannot observe
 * server-to-server traffic on its own, so every record carries the evidence
 * channel it arrived through. UI surfaces must never blur these together.
 */
export type CaptureChannel =
  /** Observed inside the page via patched fetch/XHR/WebSocket/EventSource. */
  | 'page-hook'
  /** Observed by the browser network stack (webRequest / DevTools network). */
  | 'browser-network'
  /** Synthesised by the extension when a mock short-circuited the request. */
  | 'browser-mock'
  /** Reported by an instrumented backend process through the QA agent. */
  | 'server-sdk'
  /** Observed by the QA agent's reverse proxy sitting in front of a service. */
  | 'qa-proxy'
  /** Produced by a manual replay initiated from the UI. */
  | 'replay'
  /** Imported from an external file (HAR, previous session, automation run). */
  | 'imported';

/** Logical tier a request belongs to within a full-stack journey. */
export type RequestSource =
  | 'browser'
  | 'frontend-server'
  | 'bff'
  | 'gateway'
  | 'internal-service'
  | 'external-api';

export type RequestMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'TRACE'
  | 'CONNECT';

export type RequestType =
  | 'fetch'
  | 'xhr'
  | 'graphql'
  | 'websocket'
  | 'sse'
  | 'navigation'
  | 'form'
  | 'beacon'
  | 'static'
  | 'server'
  | 'other';

/** How a body was stored, so consumers never mis-render binary or partial data. */
export type BodyEncoding = 'utf8' | 'base64' | 'omitted' | 'truncated';

export interface CapturedBody {
  encoding: BodyEncoding;
  /** Present unless `encoding === 'omitted'`. */
  content: string | null;
  /** Size of the *original* payload in bytes, before truncation. */
  byteLength: number;
  mimeType: string | null;
  /** Reason the body is not fully present, for honest UI messaging. */
  omittedReason: string | null;
}

export interface RequestTiming {
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  /** Time the mock engine deliberately delayed the response, if any. */
  injectedDelayMs: number | null;
}

export interface MockAttribution {
  ruleId: string;
  ruleName: string;
  scenarioId: string | null;
  /** Which engine produced the mocked response. */
  transport: 'page-hook' | 'chromium-network' | 'qa-proxy' | 'server-sdk';
  failureType: string;
  appliedAt: number;
}

export interface GraphQLDescriptor {
  operationName: string | null;
  operationType: 'query' | 'mutation' | 'subscription';
}

export interface CapturedRequest {
  id: string;
  sessionId: string;
  /** Stable identity of the page/tab or backend process that emitted it. */
  originId: string;
  channel: CaptureChannel;
  source: RequestSource;
  type: RequestType;
  method: RequestMethod;
  url: string;
  path: string;
  hostname: string;
  port: number | null;
  scheme: string;
  queryParams: Record<string, string>;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: CapturedBody | null;
  responseBody: CapturedBody | null;
  statusCode: number | null;
  statusText: string | null;
  timing: RequestTiming;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  correlationId: string | null;
  /** Id of the request this one retries, when a retry chain was detected. */
  retryOf: string | null;
  retryAttempt: number;
  serviceName: string | null;
  /** Environment key (`dev`, `qa`, `prod`, …) resolved at capture time. */
  environmentId: string | null;
  mock: MockAttribution | null;
  error: string | null;
  initiator: string | null;
  pageUrl: string | null;
  graphql: GraphQLDescriptor | null;
  /** Redaction already applied to this record; never re-derive from raw data. */
  redactedFields: string[];
  tags: string[];
}

export type RequestClassFilter =
  | 'client-side'
  | 'server-side'
  | 'mocked'
  | 'replayed'
  | 'failed'
  | 'slow';

export interface RequestFilter {
  search?: string;
  methods?: RequestMethod[];
  types?: RequestType[];
  sources?: RequestSource[];
  channels?: CaptureChannel[];
  /** Status buckets such as `2xx`, `4xx`, `5xx`, `err`, or an exact code. */
  statusBuckets?: string[];
  hostnames?: string[];
  traceId?: string;
  correlationId?: string;
  minDurationMs?: number;
  maxDurationMs?: number;
  classes?: RequestClassFilter[];
  includeStatic?: boolean;
  bookmarkedOnly?: boolean;
}

export const DEFAULT_SLOW_REQUEST_MS = 1000;
