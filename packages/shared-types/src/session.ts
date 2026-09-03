import type { CapturedRequest } from './request';
import type { TraceSpan } from './trace';

export type SessionStatus = 'recording' | 'paused' | 'stopped';

export interface SessionMarker {
  id: string;
  kind: 'navigation' | 'user-action' | 'console-error' | 'test-step' | 'note' | 'screenshot';
  label: string;
  timestamp: number;
  detail: string | null;
  /** Data URL or agent-relative path for screenshots. */
  resourceRef: string | null;
  /** Scenario this evidence belongs to. Older sessions may not contain it. */
  scenarioId?: string | null;
}

export type EvidenceScenarioStatus = 'not-run' | 'in-progress' | 'passed' | 'failed' | 'blocked';

export interface EvidenceScenario {
  id: string;
  title: string;
  expectedResult: string;
  actualResult: string;
  status: EvidenceScenarioStatus;
  startedAt: number | null;
  endedAt: number | null;
  notes: string;
}

export interface QaSession {
  id: string;
  name: string;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
  environmentId: string | null;
  startUrl: string | null;
  userAgent: string | null;
  /** Rule ids active while this session was recorded. */
  activeRuleIds: string[];
  markers: SessionMarker[];
  tags: string[];
  notes: string;
  /** Named flows grouped under this evidence subject. Optional for legacy sessions. */
  scenarios?: EvidenceScenario[];
  /** Scenario currently receiving screenshots and timeline evidence. */
  activeScenarioId?: string | null;
}

export interface SessionStats {
  requestCount: number;
  failedCount: number;
  mockedCount: number;
  replayedCount: number;
  serverSideCount: number;
  traceCount: number;
  averageDurationMs: number;
  p95DurationMs: number;
  slowest: { requestId: string; label: string; durationMs: number } | null;
  statusBuckets: Record<string, number>;
  pageCount: number;
  durationMs: number;
}

export interface SessionSnapshot {
  session: QaSession;
  requests: CapturedRequest[];
  spans: TraceSpan[];
  stats: SessionStats;
}

export interface Bookmark {
  id: string;
  requestId: string;
  label: string;
  note: string;
  createdAt: number;
}

export interface CatalogEntry {
  id: string;
  method: string;
  hostname: string;
  /** Path with numeric/uuid segments collapsed, e.g. `/orders/{id}`. */
  pathTemplate: string;
  name: string;
  notes: string;
  tags: string[];
  observedCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  statusCodesSeen: number[];
  averageDurationMs: number;
  /** Example request id for opening a concrete sample. */
  sampleRequestId: string | null;
}

export interface ApiCatalog {
  entries: CatalogEntry[];
  generatedAt: number;
}

/** Retention configuration; local-first storage must be self-cleaning. */
export interface RetentionPolicy {
  maxSessions: number;
  maxRequestsPerSession: number;
  autoDeleteAfterDays: number;
  maxBodyBytes: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxSessions: 25,
  maxRequestsPerSession: 5000,
  autoDeleteAfterDays: 7,
  maxBodyBytes: 512 * 1024,
};
