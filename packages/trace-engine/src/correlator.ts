import type { CapturedRequest, TraceHeaderConfig, TraceSpan } from '@apilens/shared-types';
import { DEFAULT_TRACE_HEADER_CONFIG } from '@apilens/shared-types';
import { endpointKey } from '@apilens/core';
import { extractTraceContext } from './headers';
import { requestToSpan, syntheticSpanId, syntheticTraceId } from './span-mapper';

/**
 * Fills in `traceId` / `spanId` / `correlationId` on a captured request from
 * whatever propagation headers are present.
 *
 * When no propagation exists the request keeps `traceId === null`; grouping is
 * then handled explicitly by the synthetic path so the UI can distinguish
 * "propagated" from "inferred".
 */
export function enrichWithTraceContext(
  request: CapturedRequest,
  config: TraceHeaderConfig = DEFAULT_TRACE_HEADER_CONFIG,
): CapturedRequest {
  const context = extractTraceContext(request.requestHeaders, request.responseHeaders, config);
  if (!context) return request;
  return {
    ...request,
    traceId: request.traceId ?? context.traceId,
    spanId: request.spanId ?? context.spanId,
    parentSpanId: request.parentSpanId ?? context.parentSpanId,
    correlationId: request.correlationId ?? context.correlationId,
  };
}

export interface CorrelationResult {
  spans: TraceSpan[];
  /** span id → captured request id. */
  requestIdBySpanId: Map<string, string>;
  /** captured request id → trace id actually used for grouping. */
  traceIdByRequestId: Map<string, string>;
  /** Requests whose trace id was inferred rather than propagated. */
  syntheticRequestIds: Set<string>;
}

/**
 * Merges browser-observed requests with server-reported spans into one span
 * collection ready for tree building.
 *
 * A server span replaces the browser projection when both describe the same
 * span id, because the server has richer information (service name, real
 * parentage). Browser requests without any server counterpart are projected
 * into synthetic spans.
 */
export function correlate(
  requests: CapturedRequest[],
  serverSpans: TraceSpan[],
  config: TraceHeaderConfig = DEFAULT_TRACE_HEADER_CONFIG,
): CorrelationResult {
  const enriched = requests.map((request) => enrichWithTraceContext(request, config));

  const requestIdBySpanId = new Map<string, string>();
  const traceIdByRequestId = new Map<string, string>();
  const syntheticRequestIds = new Set<string>();
  const spansById = new Map<string, TraceSpan>();

  serverSpans.forEach((span) => spansById.set(span.spanId, span));

  // Correlation id fallback: a backend that only echoes `x-correlation-id`
  // still lets us join the browser call to its server-side trace.
  const traceIdByCorrelation = new Map<string, string>();
  serverSpans.forEach((span) => {
    const correlation = span.attributes['apilens.correlation_id'];
    if (typeof correlation === 'string' && correlation) traceIdByCorrelation.set(correlation, span.traceId);
  });

  enriched.forEach((request) => {
    // A correlation-only identity must yield to a server trace that echoes the
    // same correlation id, otherwise the browser call would sit in its own
    // island instead of joining the real distributed trace.
    const correlationOnly =
      request.correlationId !== null && request.traceId === request.correlationId;
    const viaCorrelation =
      request.correlationId !== null ? traceIdByCorrelation.get(request.correlationId) ?? null : null;

    const correlatedTraceId =
      correlationOnly || request.traceId === null ? viaCorrelation ?? request.traceId : request.traceId;

    const effective: CapturedRequest = correlatedTraceId
      ? { ...request, traceId: correlatedTraceId }
      : request;

    if (!effective.traceId) syntheticRequestIds.add(effective.id);

    const projected = requestToSpan(effective);
    traceIdByRequestId.set(effective.id, projected.traceId);

    const existing = spansById.get(projected.spanId);
    if (existing) {
      // Server span wins, but keep browser-only details it cannot know.
      spansById.set(projected.spanId, {
        ...existing,
        url: existing.url ?? projected.url,
        method: existing.method ?? projected.method,
        mockedBy: existing.mockedBy ?? projected.mockedBy,
      });
      requestIdBySpanId.set(projected.spanId, effective.id);
      return;
    }

    spansById.set(projected.spanId, projected);
    requestIdBySpanId.set(projected.spanId, effective.id);
  });

  return {
    spans: [...spansById.values()],
    requestIdBySpanId,
    traceIdByRequestId,
    syntheticRequestIds,
  };
}

export interface RetryDetectionOptions {
  /** Two identical calls closer than this are candidates for a retry chain. */
  windowMs: number;
  /** Only responses at or above this status start a retry chain. */
  minFailureStatus: number;
}

export const DEFAULT_RETRY_OPTIONS: RetryDetectionOptions = { windowMs: 30_000, minFailureStatus: 408 };

/**
 * Links repeated calls to the same endpoint that follow a failure into a retry
 * chain. Purely evidence based: a retry is only recorded when the previous
 * attempt actually failed.
 */
export function detectRetries(
  requests: CapturedRequest[],
  options: RetryDetectionOptions = DEFAULT_RETRY_OPTIONS,
): CapturedRequest[] {
  const ordered = [...requests].sort((left, right) => left.timing.startedAt - right.timing.startedAt);
  const lastAttempt = new Map<string, { request: CapturedRequest; attempt: number }>();
  const output = new Map<string, CapturedRequest>();

  ordered.forEach((request) => {
    const key = endpointKey(request.method, request.hostname, request.path);
    const previous = lastAttempt.get(key);
    const previousFailed =
      previous !== undefined &&
      (previous.request.error !== null ||
        (previous.request.statusCode !== null && previous.request.statusCode >= options.minFailureStatus));
    const withinWindow =
      previous !== undefined && request.timing.startedAt - previous.request.timing.startedAt <= options.windowMs;

    if (previous && previousFailed && withinWindow) {
      const attempt = previous.attempt + 1;
      const updated: CapturedRequest = { ...request, retryOf: previous.request.id, retryAttempt: attempt };
      output.set(request.id, updated);
      lastAttempt.set(key, { request: updated, attempt });
      return;
    }

    const reset: CapturedRequest = { ...request, retryOf: null, retryAttempt: 0 };
    output.set(request.id, reset);
    lastAttempt.set(key, { request: reset, attempt: 0 });
  });

  return requests.map((request) => output.get(request.id) ?? request);
}

/** Groups requests by the trace they belong to, including synthetic grouping. */
export function groupRequestsByTrace(
  requests: CapturedRequest[],
  config: TraceHeaderConfig = DEFAULT_TRACE_HEADER_CONFIG,
): Map<string, CapturedRequest[]> {
  const grouped = new Map<string, CapturedRequest[]>();
  requests.forEach((request) => {
    const enriched = enrichWithTraceContext(request, config);
    const traceId = enriched.traceId ?? syntheticTraceId(enriched);
    const bucket = grouped.get(traceId);
    if (bucket) bucket.push(enriched);
    else grouped.set(traceId, [enriched]);
  });
  return grouped;
}

export function spanIdForRequest(request: CapturedRequest): string {
  return request.spanId ?? syntheticSpanId(request);
}
