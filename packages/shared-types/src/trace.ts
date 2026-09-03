import type { CaptureChannel, RequestSource } from './request';

export type SpanKind = 'client' | 'server' | 'internal' | 'producer' | 'consumer';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

/**
 * A single unit of work in a distributed trace.
 *
 * Field names intentionally mirror the OpenTelemetry span model so an OTLP
 * exporter can be mapped onto this shape without inventing a proprietary
 * protocol.
 */
export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  sessionId: string;
  serviceName: string;
  operationName: string;
  kind: SpanKind;
  source: RequestSource;
  channel: CaptureChannel;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  status: SpanStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  error: string | null;
  /** Rule name when a mock produced this span's response. */
  mockedBy: string | null;
}

/** A span plus the browser-side request it was matched to, when one exists. */
export interface TraceNode {
  span: TraceSpan;
  /** `CapturedRequest.id` this node corresponds to, when known. */
  requestId: string | null;
  children: TraceNode[];
  depth: number;
  /** True when the parent span id referenced a span we never received. */
  orphaned: boolean;
  /** Aggregate of this node and all descendants. */
  subtreeDurationMs: number;
  /** Duration not accounted for by children — time spent in this service. */
  selfDurationMs: number;
}

export interface TraceTree {
  traceId: string;
  roots: TraceNode[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  mockedCount: number;
  services: string[];
  /** True when at least one referenced parent span was never received. */
  hasGaps: boolean;
}

export interface WaterfallRow {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  requestId: string | null;
  label: string;
  serviceName: string;
  source: RequestSource;
  channel: CaptureChannel;
  method: string | null;
  statusCode: number | null;
  status: SpanStatus;
  depth: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** 0-1 horizontal offset relative to the trace window. */
  offsetRatio: number;
  /** 0-1 width relative to the trace window. */
  widthRatio: number;
  mockedBy: string | null;
  error: string | null;
  orphaned: boolean;
}

export interface Waterfall {
  traceId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  rows: WaterfallRow[];
}

/** Well-known correlation headers ApiLens understands out of the box. */
export const TRACE_HEADERS = {
  traceparent: 'traceparent',
  tracestate: 'tracestate',
  requestId: 'x-request-id',
  correlationId: 'x-correlation-id',
  legacyRequestId: 'request-id',
  b3TraceId: 'x-b3-traceid',
  b3SpanId: 'x-b3-spanid',
  b3ParentSpanId: 'x-b3-parentspanid',
  b3Single: 'b3',
} as const;

export interface TraceHeaderConfig {
  /** Extra headers treated as a trace id, highest priority first. */
  traceIdHeaders: string[];
  /** Extra headers treated as a correlation id, highest priority first. */
  correlationIdHeaders: string[];
  /** Extra headers treated as a span id. */
  spanIdHeaders: string[];
  /** Extra headers treated as a parent span id. */
  parentSpanIdHeaders: string[];
}

export const DEFAULT_TRACE_HEADER_CONFIG: TraceHeaderConfig = {
  traceIdHeaders: [],
  correlationIdHeaders: [],
  spanIdHeaders: [],
  parentSpanIdHeaders: [],
};

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sampled: boolean;
  correlationId: string | null;
  /** Which header the identity was recovered from, for UI transparency. */
  derivedFrom: string;
}

export interface ServiceDependencyEdge {
  from: string;
  to: string;
  callCount: number;
  errorCount: number;
  totalDurationMs: number;
  averageDurationMs: number;
  p95DurationMs: number;
}

export interface ServiceDependencyGraph {
  nodes: Array<{ service: string; source: RequestSource; callCount: number; errorCount: number }>;
  edges: ServiceDependencyEdge[];
}
