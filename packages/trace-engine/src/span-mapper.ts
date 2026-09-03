import type { CapturedRequest, SpanStatus, TraceSpan } from '@apilens/shared-types';
import { createSpanId, createTraceId, hashString, requestLabel } from '@apilens/core';

function statusOf(request: CapturedRequest): SpanStatus {
  if (request.error) return 'error';
  if (request.statusCode === null) return 'unset';
  return request.statusCode >= 400 ? 'error' : 'ok';
}

/**
 * Projects a browser-observed request into the same span model used by
 * server-side telemetry, so a single tree can hold both.
 *
 * When the request carries no trace headers a **synthetic** trace id derived
 * from its identity is used. Synthetic ids are marked in the attributes so the
 * UI can state that the grouping is heuristic rather than propagated.
 */
export function requestToSpan(request: CapturedRequest): TraceSpan {
  const synthetic = request.traceId === null;
  const traceId = request.traceId ?? syntheticTraceId(request);
  const spanId = request.spanId ?? syntheticSpanId(request);
  const startedAt = request.timing.startedAt;
  const endedAt = request.timing.completedAt ?? startedAt;

  return {
    spanId,
    traceId,
    parentSpanId: request.parentSpanId,
    sessionId: request.sessionId,
    serviceName: request.serviceName ?? request.hostname ?? 'browser',
    operationName: requestLabel(request),
    kind: 'client',
    source: request.source,
    channel: request.channel,
    method: request.method,
    url: request.url,
    statusCode: request.statusCode,
    status: statusOf(request),
    startedAt,
    endedAt,
    durationMs: request.timing.durationMs ?? Math.max(0, endedAt - startedAt),
    attributes: {
      'apilens.channel': request.channel,
      'apilens.synthetic_trace': synthetic,
      'http.method': request.method,
      'http.host': request.hostname,
      'http.target': request.path,
      ...(request.statusCode !== null ? { 'http.status_code': request.statusCode } : {}),
      ...(request.correlationId ? { 'apilens.correlation_id': request.correlationId } : {}),
    },
    events: [],
    error: request.error,
    mockedBy: request.mock?.ruleName ?? null,
  };
}

/**
 * Deterministic trace id for requests with no propagated identity.
 *
 * Requests started within the same 2-second window from the same page and
 * origin are grouped, which reliably reconstructs a single user action without
 * pretending the backend propagated a trace.
 */
export function syntheticTraceId(request: CapturedRequest): string {
  const bucket = Math.floor(request.timing.startedAt / 2000);
  const seed = `${request.sessionId}|${request.originId}|${request.pageUrl ?? ''}|${bucket}`;
  return `${hashString(seed)}${hashString(`${seed}#2`)}${hashString(`${seed}#3`)}${hashString(`${seed}#4`)}`;
}

export function syntheticSpanId(request: CapturedRequest): string {
  return `${hashString(request.id)}${hashString(`${request.id}#s`)}`;
}

export function isSyntheticTrace(span: TraceSpan): boolean {
  return span.attributes['apilens.synthetic_trace'] === true;
}

export function newTraceContextIds(): { traceId: string; spanId: string } {
  return { traceId: createTraceId(), spanId: createSpanId() };
}
