export type SpanSource = 'browser' | 'frontend-server' | 'bff' | 'gateway' | 'internal-service' | 'database' | 'cache' | 'message-queue';

export interface TraceSpan {
  id: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  sessionId: string;
  serviceName: string;
  operationName: string;
  source: SpanSource;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  error: string | null;
  scenarioApplied: string | null;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

export interface TimelineEntry {
  id: string;
  type: 'request' | 'span';
  source: SpanSource;
  serviceName: string;
  operation: string;
  method: string | null;
  url: string | null;
  statusCode: number | null;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  depth: number; // nesting level in the call chain
  parentId: string | null;
  scenarioApplied: string | null;
  isClientSide: boolean;
  error: string | null;
}

export interface TimelineData {
  sessionId: string;
  entries: TimelineEntry[];
  startTime: number;
  endTime: number;
  services: string[];
}
