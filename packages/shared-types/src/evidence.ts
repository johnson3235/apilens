import type { AssertionReport, SchemaValidationResult } from './contract';
import type { ErrorReport, PerformanceReport, QaInsight } from './insights';
import type { CapturedRequest } from './request';
import type { Rule } from './rule';
import type { QaSession, SessionStats } from './session';
import type { TraceSpan, TraceTree } from './trace';

export type EvidenceFormat = 'json' | 'har' | 'markdown' | 'html';

export interface EvidenceEnvironmentInfo {
  environmentId: string | null;
  environmentName: string | null;
  browser: string | null;
  userAgent: string | null;
  platform: string | null;
  extensionVersion: string;
  agentVersion: string | null;
}

export interface AutomationLinkage {
  framework: 'playwright' | 'cypress' | 'selenium' | 'newman' | 'rest-assured' | 'manual';
  suiteName: string | null;
  testName: string | null;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'unknown';
  steps: Array<{
    title: string;
    status: 'passed' | 'failed' | 'skipped';
    startedAt: number;
    durationMs: number;
    error: string | null;
  }>;
  attachments: Array<{ name: string; contentType: string; path: string | null }>;
}

export interface ConsoleMessage {
  level: 'error' | 'warning' | 'info';
  text: string;
  timestamp: number;
  url: string | null;
}

export interface EvidenceBundle {
  formatVersion: 1;
  generatedAt: number;
  session: QaSession;
  stats: SessionStats;
  environment: EvidenceEnvironmentInfo;
  requests: CapturedRequest[];
  spans: TraceSpan[];
  traces: TraceTree[];
  appliedRules: Rule[];
  insights: QaInsight[];
  errors: ErrorReport;
  performance: PerformanceReport;
  assertions: AssertionReport | null;
  schemaValidations: Array<{ requestId: string; result: SchemaValidationResult }>;
  consoleMessages: ConsoleMessage[];
  automation: AutomationLinkage | null;
  /** True when the user disabled masking; consumers must display a warning. */
  containsUnmaskedSecrets: boolean;
}

export interface EvidenceExportOptions {
  formats: EvidenceFormat[];
  includeBodies: boolean;
  includeStaticAssets: boolean;
  /** Explicit, deliberate opt-out of masking. */
  disableRedaction: boolean;
  title: string;
}

export const DEFAULT_EVIDENCE_EXPORT_OPTIONS: EvidenceExportOptions = {
  formats: ['json', 'har', 'markdown', 'html'],
  includeBodies: true,
  includeStaticAssets: false,
  disableRedaction: false,
  title: 'ApiLens QA Evidence',
};

export interface EvidenceArtifact {
  fileName: string;
  contentType: string;
  content: string;
}
