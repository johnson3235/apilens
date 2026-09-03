export type InsightSeverity = 'info' | 'warning' | 'critical';

export type InsightKind =
  | 'duplicate-request'
  | 'slow-request'
  | 'slow-downstream'
  | 'sequential-waterfall'
  | 'retry-loop'
  | 'large-response'
  | 'excessive-calls'
  | 'inconsistent-response'
  | 'failed-downstream'
  | 'uncached-repeat'
  | 'oversized-request';

/**
 * Insights are strictly deterministic and evidence-based.
 *
 * `observed` states only what the captured data proves. `possibleCause` is
 * clearly separated so the UI never presents a hypothesis as a fact.
 */
export interface QaInsight {
  id: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  observed: string;
  possibleCause: string | null;
  recommendation: string | null;
  requestIds: string[];
  traceIds: string[];
  /** Numeric evidence backing the insight, rendered as a small table. */
  metrics: Record<string, number | string>;
}

export type ErrorCategory =
  | 'client-error'
  | 'server-error'
  | 'timeout'
  | 'network-error'
  | 'cors'
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'invalid-json'
  | 'unexpected-response'
  | 'aborted';

export interface ErrorGroup {
  id: string;
  category: ErrorCategory;
  label: string;
  count: number;
  requestIds: string[];
  /** Representative request for the detail pane. */
  sampleRequestId: string;
  statusCodes: number[];
  hostnames: string[];
  /**
   * Deepest failing service in the trace, when trace evidence exists.
   * `null` when there is no server-side telemetry to attribute the failure.
   */
  likelyFailureSource: {
    service: string;
    spanId: string;
    confidence: 'observed' | 'inferred';
    explanation: string;
  } | null;
}

export interface ErrorReport {
  groups: ErrorGroup[];
  totalErrors: number;
  generatedAt: number;
}

export interface PerformanceReport {
  totalRequests: number;
  totalDurationMs: number;
  averageDurationMs: number;
  medianDurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  slowest: Array<{ requestId: string; label: string; durationMs: number }>;
  byHost: Array<{ hostname: string; count: number; totalDurationMs: number; averageDurationMs: number }>;
  totalTransferredBytes: number;
  insights: QaInsight[];
}

export type ScenarioSuggestionRisk = 'safe' | 'requires-care' | 'destructive';

export interface ScenarioSuggestion {
  id: string;
  title: string;
  description: string;
  failureType: string;
  statusCode: number | null;
  risk: ScenarioSuggestionRisk;
  /** Ready-to-apply rule draft, expressed as a preset id plus a URL pattern. */
  presetId: string;
  urlPattern: string;
  method: string;
}

export interface ScenarioSuggestionSet {
  endpoint: string;
  method: string;
  suggestions: ScenarioSuggestion[];
}
