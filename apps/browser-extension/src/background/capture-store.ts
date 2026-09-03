import type { CapturedRequest, QaSession, RetentionPolicy, TraceSpan } from '@apilens/shared-types';
import { createId } from '@apilens/core';
import { CaptureDatabase } from '../shared/db';

export interface CaptureStoreEvents {
  onRequests(sessionId: string, requests: CapturedRequest[]): void;
  onSpans(sessionId: string, spans: TraceSpan[]): void;
}

const FLUSH_INTERVAL_MS = 750;
const MAX_LIVE_REQUESTS = 5_000;

/**
 * Buffers captured traffic in memory and flushes it to IndexedDB in batches.
 *
 * Two goals: never block a page's network path on a database write, and never
 * lose data when MV3 suspends the service worker. The buffer is flushed on a
 * short timer and again whenever the worker is about to go idle.
 */
export class CaptureStore {
  private readonly db = new CaptureDatabase();
  private session: QaSession | null = null;
  private readonly live = new Map<string, CapturedRequest>();
  private readonly liveSpans = new Map<string, TraceSpan>();
  private pendingRequests: CapturedRequest[] = [];
  private pendingSpans: TraceSpan[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly events: CaptureStoreEvents) {}

  currentSession(): QaSession | null {
    return this.session;
  }

  isRecording(): boolean {
    return this.session?.status === 'recording';
  }

  async startSession(input: { name: string; startUrl: string | null; environmentId: string | null; userAgent: string | null }): Promise<QaSession> {
    await this.flush();
    this.live.clear();
    this.liveSpans.clear();

    this.session = {
      id: createId(),
      name: input.name || `QA session ${new Date().toLocaleString()}`,
      status: 'recording',
      startedAt: Date.now(),
      endedAt: null,
      environmentId: input.environmentId,
      startUrl: input.startUrl,
      userAgent: input.userAgent,
      activeRuleIds: [],
      markers: [],
      tags: [],
      notes: '',
      scenarios: [],
      activeScenarioId: null,
    };
    await this.db.putSession(this.session);
    return this.session;
  }

  async stopSession(): Promise<QaSession | null> {
    if (!this.session) return null;
    await this.flush();
    this.session = { ...this.session, status: 'stopped', endedAt: Date.now(), activeScenarioId: null };
    await this.db.putSession(this.session);
    return this.session;
  }

  async updateSession(patch: Partial<QaSession>): Promise<QaSession | null> {
    if (!this.session) return null;
    this.session = { ...this.session, ...patch };
    await this.db.putSession(this.session);
    return this.session;
  }

  /** Restores the most recent recording session after a worker restart. */
  async restore(): Promise<QaSession | null> {
    const sessions = await this.db.listSessions();
    const recording = sessions.find((session) => session.status === 'recording');
    if (!recording) return null;
    this.session = recording;
    const requests = await this.db.getRequests(recording.id);
    requests.slice(-MAX_LIVE_REQUESTS).forEach((request) => this.live.set(request.id, request));
    (await this.db.getSpans(recording.id)).forEach((span) => this.liveSpans.set(span.spanId, span));
    return recording;
  }

  addRequests(requests: CapturedRequest[]): CapturedRequest[] {
    if (!this.session || this.session.status !== 'recording' || requests.length === 0) return [];
    const sessionId = this.session.id;
    const stamped = requests.map((request) => ({ ...request, sessionId }));

    stamped.forEach((request) => this.live.set(request.id, request));
    this.trimLive();
    this.pendingRequests.push(...stamped);
    this.scheduleFlush();
    this.events.onRequests(sessionId, stamped);
    return stamped;
  }

  addSpans(spans: TraceSpan[]): TraceSpan[] {
    if (!this.session || spans.length === 0) return [];
    const sessionId = this.session.id;
    const accepted = spans.filter((span) => !this.liveSpans.has(span.spanId)).map((span) => ({ ...span, sessionId }));
    if (accepted.length === 0) return [];

    accepted.forEach((span) => this.liveSpans.set(span.spanId, span));
    this.pendingSpans.push(...accepted);
    this.scheduleFlush();
    this.events.onSpans(sessionId, accepted);
    return accepted;
  }

  liveRequests(): CapturedRequest[] {
    return [...this.live.values()].sort((left, right) => left.timing.startedAt - right.timing.startedAt);
  }

  liveSpanList(): TraceSpan[] {
    return [...this.liveSpans.values()].sort((left, right) => left.startedAt - right.startedAt);
  }

  async requestsFor(sessionId: string): Promise<CapturedRequest[]> {
    if (this.session?.id === sessionId) {
      await this.flush();
      return this.liveRequests();
    }
    return this.db.getRequests(sessionId);
  }

  async spansFor(sessionId: string): Promise<TraceSpan[]> {
    if (this.session?.id === sessionId) {
      await this.flush();
      return this.liveSpanList();
    }
    return this.db.getSpans(sessionId);
  }

  async listSessions(): Promise<QaSession[]> {
    await this.flush();
    return this.db.listSessions();
  }

  async getSession(sessionId: string): Promise<QaSession | null> {
    return this.db.getSession(sessionId);
  }

  async clearCurrent(): Promise<void> {
    this.live.clear();
    this.liveSpans.clear();
    this.pendingRequests = [];
    this.pendingSpans = [];
    if (this.session) await this.db.deleteSession(this.session.id);
    if (this.session) await this.db.putSession(this.session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.deleteSession(sessionId);
    if (this.session?.id === sessionId) {
      this.session = null;
      this.live.clear();
      this.liveSpans.clear();
    }
  }

  async clearAll(): Promise<void> {
    this.pendingRequests = [];
    this.pendingSpans = [];
    this.live.clear();
    this.liveSpans.clear();
    this.session = null;
    await this.db.clearAll();
  }

  async enforceRetention(policy: RetentionPolicy): Promise<void> {
    await this.flush();
    await this.db.enforceRetention(policy.maxSessions, policy.autoDeleteAfterDays, policy.maxRequestsPerSession);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const requests = this.pendingRequests;
    const spans = this.pendingSpans;
    this.pendingRequests = [];
    this.pendingSpans = [];

    if (requests.length === 0 && spans.length === 0) return;
    try {
      await this.db.putRequests(requests);
      await this.db.putSpans(spans);
    } catch (error) {
      // A failed write must not lose the data or crash the worker; retry next tick.
      this.pendingRequests.unshift(...requests);
      this.pendingSpans.unshift(...spans);
      console.warn('ApiLens could not persist captured data:', error);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  private trimLive(): void {
    if (this.live.size <= MAX_LIVE_REQUESTS) return;
    const excess = this.live.size - MAX_LIVE_REQUESTS;
    const keys = this.live.keys();
    for (let index = 0; index < excess; index += 1) {
      const next = keys.next();
      if (next.done) break;
      this.live.delete(next.value);
    }
  }
}
