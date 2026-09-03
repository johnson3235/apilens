import type { CapturedRequest, QaSession, Rule, SessionMarker, TraceSpan } from '@apilens/shared-types';
import { detectRetries } from '@apilens/trace-engine';

export interface SessionRecord {
  session: QaSession;
  requests: Map<string, CapturedRequest>;
  spans: Map<string, TraceSpan>;
  rules: Rule[];
  lastActivityAt: number;
}

export interface StoreLimits {
  maxSessions: number;
  maxRequestsPerSession: number;
  maxSpansPerSession: number;
  autoDeleteAfterDays: number;
}

/**
 * In-memory session store with bounded growth.
 *
 * Local-first by design: nothing leaves the machine and nothing is required to
 * be running before the agent starts. Bounds are enforced on every write so a
 * long-running session can never exhaust memory.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly limits: StoreLimits) {}

  startSession(session: QaSession): SessionRecord {
    const existing = this.sessions.get(session.id);
    if (existing) {
      existing.session = { ...existing.session, ...session };
      existing.lastActivityAt = Date.now();
      return existing;
    }

    const record: SessionRecord = {
      session,
      requests: new Map(),
      spans: new Map(),
      rules: [],
      lastActivityAt: Date.now(),
    };
    this.sessions.set(session.id, record);
    this.evictOldSessions();
    return record;
  }

  stopSession(sessionId: string, endedAt = Date.now()): SessionRecord | null {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    record.session = { ...record.session, status: 'stopped', endedAt };
    record.lastActivityAt = endedAt;
    return record;
  }

  /** Creates a placeholder session so late-arriving spans are never dropped. */
  ensureSession(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    return this.startSession({
      id: sessionId,
      name: `Session ${sessionId.slice(0, 8)}`,
      status: 'recording',
      startedAt: Date.now(),
      endedAt: null,
      environmentId: null,
      startUrl: null,
      userAgent: null,
      activeRuleIds: [],
      markers: [],
      tags: [],
      notes: '',
    });
  }

  addRequests(sessionId: string, requests: CapturedRequest[]): CapturedRequest[] {
    if (requests.length === 0) return [];
    const record = this.ensureSession(sessionId);
    requests.forEach((request) => record.requests.set(request.id, request));

    // Retry chains can only be recognised with the full history in hand.
    const withRetries = detectRetries([...record.requests.values()]);
    record.requests = new Map(withRetries.map((request) => [request.id, request]));

    this.trim(record.requests, this.limits.maxRequestsPerSession);
    record.lastActivityAt = Date.now();

    const ids = new Set(requests.map((request) => request.id));
    return withRetries.filter((request) => ids.has(request.id));
  }

  addSpans(sessionId: string, spans: TraceSpan[]): TraceSpan[] {
    if (spans.length === 0) return [];
    const record = this.ensureSession(sessionId);
    const accepted: TraceSpan[] = [];
    spans.forEach((span) => {
      if (record.spans.has(span.spanId)) return;
      record.spans.set(span.spanId, span);
      accepted.push(span);
    });
    this.trim(record.spans, this.limits.maxSpansPerSession);
    record.lastActivityAt = Date.now();
    return accepted;
  }

  addMarker(sessionId: string, marker: SessionMarker): void {
    const record = this.ensureSession(sessionId);
    record.session = { ...record.session, markers: [...record.session.markers, marker] };
    record.lastActivityAt = Date.now();
  }

  setRules(sessionId: string, rules: Rule[]): void {
    const record = this.ensureSession(sessionId);
    record.rules = rules;
    record.session = { ...record.session, activeRuleIds: rules.filter((rule) => rule.enabled).map((rule) => rule.id) };
    record.lastActivityAt = Date.now();
  }

  getRules(sessionId: string): Rule[] {
    return this.sessions.get(sessionId)?.rules ?? [];
  }

  /** Rules from any active session, used by the proxy which has no session context. */
  getAllActiveRules(): Rule[] {
    return [...this.sessions.values()]
      .filter((record) => record.session.status === 'recording')
      .flatMap((record) => record.rules);
  }

  activeSessionId(): string | null {
    const recording = [...this.sessions.values()]
      .filter((record) => record.session.status === 'recording')
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
    return recording[0]?.session.id ?? null;
  }

  get(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  list(): QaSession[] {
    return [...this.sessions.values()]
      .map((record) => record.session)
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  requests(sessionId: string): CapturedRequest[] {
    const record = this.sessions.get(sessionId);
    if (!record) return [];
    return [...record.requests.values()].sort((left, right) => left.timing.startedAt - right.timing.startedAt);
  }

  spans(sessionId: string): TraceSpan[] {
    const record = this.sessions.get(sessionId);
    if (!record) return [];
    return [...record.spans.values()].sort((left, right) => left.startedAt - right.startedAt);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  size(): number {
    return this.sessions.size;
  }

  /** Removes sessions past the retention window. */
  pruneExpired(now = Date.now()): string[] {
    const cutoff = now - this.limits.autoDeleteAfterDays * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    this.sessions.forEach((record, id) => {
      if (record.lastActivityAt < cutoff) {
        this.sessions.delete(id);
        removed.push(id);
      }
    });
    return removed;
  }

  private evictOldSessions(): void {
    while (this.sessions.size > this.limits.maxSessions) {
      const oldest = [...this.sessions.entries()].sort(
        (left, right) => left[1].lastActivityAt - right[1].lastActivityAt,
      )[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
    }
  }

  private trim<T>(map: Map<string, T>, limit: number): void {
    if (map.size <= limit) return;
    const excess = map.size - limit;
    const keys = map.keys();
    for (let index = 0; index < excess; index += 1) {
      const next = keys.next();
      if (next.done) break;
      map.delete(next.value);
    }
  }
}
