import type { TraceContext, TraceHeaderConfig } from '@apilens/shared-types';
import { DEFAULT_TRACE_HEADER_CONFIG, TRACE_HEADERS } from '@apilens/shared-types';
import { getHeader } from '@apilens/core';

const TRACEPARENT = /^(\d{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const B3_SINGLE = /^([0-9a-f]{16,32})-([0-9a-f]{16})(?:-([01d])(?:-([0-9a-f]{16}))?)?$/i;

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  sampled: boolean;
}

/** Parses a W3C `traceparent` header. Returns `null` for anything malformed. */
export function parseTraceparent(value: string | undefined | null): ParsedTraceparent | null {
  if (!value) return null;
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return null;
  const [, version, traceId, spanId, flags] = match;
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return {
    version: version!.toLowerCase(),
    traceId: traceId!.toLowerCase(),
    spanId: spanId!.toLowerCase(),
    sampled: (Number.parseInt(flags!, 16) & 0x01) === 1,
  };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export interface ParsedB3 {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
}

/** Parses both the single-header (`b3`) and multi-header B3 formats. */
export function parseB3(headers: Record<string, string>): ParsedB3 | null {
  const single = getHeader(headers, TRACE_HEADERS.b3Single);
  if (single) {
    if (single === '0') return null;
    const match = B3_SINGLE.exec(single.trim());
    if (match) {
      return {
        traceId: match[1]!.toLowerCase(),
        spanId: match[2]!.toLowerCase(),
        parentSpanId: match[4] ? match[4].toLowerCase() : null,
        sampled: match[3] !== '0',
      };
    }
  }

  const traceId = getHeader(headers, TRACE_HEADERS.b3TraceId);
  const spanId = getHeader(headers, TRACE_HEADERS.b3SpanId);
  if (!traceId || !spanId) return null;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    parentSpanId: getHeader(headers, TRACE_HEADERS.b3ParentSpanId)?.toLowerCase() ?? null,
    sampled: true,
  };
}

function firstHeader(headers: Record<string, string>, names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = getHeader(headers, name);
    if (value) return { name: name.toLowerCase(), value };
  }
  return null;
}

/**
 * Recovers a trace identity from request and response headers.
 *
 * Priority order: W3C traceparent → B3 → configured custom headers →
 * `x-request-id` / `x-correlation-id`. The header the identity came from is
 * always reported so the UI can explain *why* two requests were linked.
 */
export function extractTraceContext(
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string> = {},
  config: TraceHeaderConfig = DEFAULT_TRACE_HEADER_CONFIG,
): TraceContext | null {
  const merged = { ...responseHeaders, ...requestHeaders };

  const correlation = firstHeader(merged, [
    ...config.correlationIdHeaders,
    TRACE_HEADERS.correlationId,
    TRACE_HEADERS.requestId,
    TRACE_HEADERS.legacyRequestId,
  ]);

  const traceparent = parseTraceparent(getHeader(merged, TRACE_HEADERS.traceparent));
  if (traceparent) {
    return {
      traceId: traceparent.traceId,
      spanId: traceparent.spanId,
      parentSpanId: null,
      sampled: traceparent.sampled,
      correlationId: correlation?.value ?? null,
      derivedFrom: TRACE_HEADERS.traceparent,
    };
  }

  const b3 = parseB3(merged);
  if (b3) {
    return {
      traceId: b3.traceId,
      spanId: b3.spanId,
      parentSpanId: b3.parentSpanId,
      sampled: b3.sampled,
      correlationId: correlation?.value ?? null,
      derivedFrom: getHeader(merged, TRACE_HEADERS.b3Single) ? TRACE_HEADERS.b3Single : TRACE_HEADERS.b3TraceId,
    };
  }

  const customTrace = firstHeader(merged, config.traceIdHeaders);
  if (customTrace) {
    const customSpan = firstHeader(merged, config.spanIdHeaders);
    const customParent = firstHeader(merged, config.parentSpanIdHeaders);
    return {
      traceId: customTrace.value,
      spanId: customSpan?.value ?? customTrace.value,
      parentSpanId: customParent?.value ?? null,
      sampled: true,
      correlationId: correlation?.value ?? null,
      derivedFrom: customTrace.name,
    };
  }

  if (correlation) {
    return {
      traceId: correlation.value,
      spanId: correlation.value,
      parentSpanId: null,
      sampled: true,
      correlationId: correlation.value,
      derivedFrom: correlation.name,
    };
  }

  return null;
}

/** Headers ApiLens injects so downstream services can join the same trace. */
export function buildPropagationHeaders(context: TraceContext): Record<string, string> {
  return {
    traceparent: formatTraceparent(context.traceId, context.spanId, context.sampled),
    'x-correlation-id': context.correlationId ?? context.traceId,
  };
}

export function mergeTraceHeaderConfig(
  base: TraceHeaderConfig,
  extra: Partial<TraceHeaderConfig>,
): TraceHeaderConfig {
  return {
    traceIdHeaders: [...new Set([...(extra.traceIdHeaders ?? []), ...base.traceIdHeaders])],
    correlationIdHeaders: [...new Set([...(extra.correlationIdHeaders ?? []), ...base.correlationIdHeaders])],
    spanIdHeaders: [...new Set([...(extra.spanIdHeaders ?? []), ...base.spanIdHeaders])],
    parentSpanIdHeaders: [...new Set([...(extra.parentSpanIdHeaders ?? []), ...base.parentSpanIdHeaders])],
  };
}
