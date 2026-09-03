import type {
  CaptureChannel,
  CapturedRequest,
  RequestMethod,
  RequestSource,
  RequestType,
} from '@apilens/shared-types';
import { createId } from './ids';
import { parseUrl } from './url';

export interface CapturedRequestInput {
  sessionId: string;
  url: string;
  method: RequestMethod;
  channel: CaptureChannel;
  source?: RequestSource;
  type?: RequestType;
  originId?: string;
  startedAt?: number;
  id?: string;
}

/**
 * Single construction point for `CapturedRequest`.
 *
 * Capture pipelines (page hooks, webRequest, proxy, SDK, replay) all funnel
 * through here so every record has the same shape and no field is silently
 * forgotten when the model evolves.
 */
export function createCapturedRequest(input: CapturedRequestInput): CapturedRequest {
  const parsed = parseUrl(input.url);
  const startedAt = input.startedAt ?? Date.now();

  return {
    id: input.id ?? createId(),
    sessionId: input.sessionId,
    originId: input.originId ?? 'unknown',
    channel: input.channel,
    source: input.source ?? (input.channel === 'server-sdk' || input.channel === 'qa-proxy' ? 'internal-service' : 'browser'),
    type: input.type ?? 'fetch',
    method: input.method,
    url: input.url,
    path: parsed.path,
    hostname: parsed.hostname,
    port: parsed.port,
    scheme: parsed.scheme,
    queryParams: parsed.query,
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    statusCode: null,
    statusText: null,
    timing: { startedAt, completedAt: null, durationMs: null, injectedDelayMs: null },
    traceId: null,
    spanId: null,
    parentSpanId: null,
    correlationId: null,
    retryOf: null,
    retryAttempt: 0,
    serviceName: null,
    environmentId: null,
    mock: null,
    error: null,
    initiator: null,
    pageUrl: null,
    graphql: null,
    redactedFields: [],
    tags: [],
  };
}

/** Applies terminal state (status, timing) to a request in an immutable way. */
export function completeRequest(
  request: CapturedRequest,
  completion: { statusCode?: number | null; statusText?: string | null; completedAt?: number; error?: string | null },
): CapturedRequest {
  const completedAt = completion.completedAt ?? Date.now();
  return {
    ...request,
    statusCode: completion.statusCode ?? request.statusCode,
    statusText: completion.statusText ?? request.statusText,
    error: completion.error ?? request.error,
    timing: {
      ...request.timing,
      completedAt,
      durationMs: Math.max(0, completedAt - request.timing.startedAt),
    },
  };
}

/** True when a request failed for any reason the QA engineer cares about. */
export function isFailedRequest(request: CapturedRequest): boolean {
  if (request.error) return true;
  return request.statusCode !== null && request.statusCode >= 400;
}

export function isClientSide(request: CapturedRequest): boolean {
  return request.channel === 'page-hook' || request.channel === 'browser-network' || request.channel === 'browser-mock';
}

export function isServerSide(request: CapturedRequest): boolean {
  return request.channel === 'server-sdk' || request.channel === 'qa-proxy';
}

export function requestLabel(request: CapturedRequest): string {
  return `${request.method} ${request.path || request.url}`;
}

export function responseBytes(request: CapturedRequest): number {
  return request.responseBody?.byteLength ?? 0;
}

export function requestBytes(request: CapturedRequest): number {
  return request.requestBody?.byteLength ?? 0;
}
