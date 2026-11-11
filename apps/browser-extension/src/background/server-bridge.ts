import type { TraceSpan } from '@apilens/shared-types';
import {
  ServerControlClient,
  ServerControlError,
  normalizeControlUrl,
  type ServerBridgeStatus,
  type ServerCall,
  type ServerControlHealth,
  type ServerMockRule,
} from '../shared/server-control';
import type { ServerControlSettings } from '../shared/settings';

/**
 * Owns the link to an instrumented server.
 *
 * Polling lives in the service worker because only it (and other extension
 * pages) can issue cross-origin requests under `host_permissions`. The panel
 * drives the cadence, which keeps the worker alive while the tester is
 * actually looking at the data instead of burning quota in the background.
 */

const MAX_CALLS = 5_000;

/** Server calls become spans so the existing trace correlation just works. */
export function serverCallToSpan(call: ServerCall): TraceSpan {
  return {
    spanId: call.spanId,
    traceId: call.traceId,
    parentSpanId: call.parentSpanId,
    sessionId: call.sessionId,
    serviceName: call.serviceName,
    operationName: `${call.method} ${call.path || call.url}`,
    kind: call.kind,
    source: 'internal-service',
    channel: 'server-sdk',
    method: call.method,
    url: call.url,
    statusCode: call.statusCode,
    status: call.status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationMs: call.durationMs,
    attributes: {
      requestHeaders: JSON.stringify(call.requestHeaders),
      responseHeaders: JSON.stringify(call.responseHeaders),
      requestBody: call.requestBody ? call.requestBody.content : '',
      responseBody: call.responseBody ? call.responseBody.content : '',
      requestBodyOmitted: call.requestBodyOmitted ?? '',
      responseBodyOmitted: call.responseBodyOmitted ?? '',
      scenario: call.scenarioId ?? '',
      timingScope: call.bodyDurationMs === null ? 'response-headers' : 'response-body',
      bodyCapture: Boolean(call.requestBody || call.responseBody),
    },
    events: [],
    error: call.error,
    mockedBy: call.mockedBy,
  };
}

export interface SyncResult {
  status: ServerBridgeStatus;
  /** Only the calls that arrived in this sync. */
  fresh: ServerCall[];
  spans: TraceSpan[];
}

/** A pod not heard from for this long is no longer listed (its calls stay). */
const POD_TTL_MS = 5 * 60_000;

interface Pod {
  processId: string;
  /** Highest seq read from this process; seq only grows, even across a clear. */
  cursor: number;
  health: ServerControlHealth | null;
  lastSeenAt: number;
  gap: boolean;
}

/** Identity of a rule set: the same rules carry the same ids, switches and edit times on every pod. */
function ruleSignature(rules: ServerMockRule[]): string {
  return rules.map((rule) => `${rule.id}:${rule.enabled ? 1 : 0}:${rule.updatedAt}`).sort().join('|');
}

const newestEdit = (rules: ServerMockRule[]): number => rules.reduce((max, rule) => Math.max(max, rule.updatedAt), 0);

export class ServerBridge {
  private settings: ServerControlSettings | null = null;
  private client: ServerControlClient | null = null;
  private readonly calls = new Map<string, ServerCall>();
  private rules: ServerMockRule[] = [];
  /**
   * Behind a load balancer every poll may reach a different pod. Each keeps
   * its own buffer and seq, so each gets its own cursor, and a new process id
   * means one more pod (or a restart), never a reason to drop what was read.
   */
  private readonly pods = new Map<string, Pod>();
  private processId: string | null = null;
  private health: ServerControlHealth | null = null;
  /** The rules this tester saved, re-applied to pods that do not have them yet (another pod, a restart). */
  private desired: { rules: ServerMockRule[]; savedAt: number } | null = null;
  private error: string | null = null;
  private lastSyncAt: number | null = null;
  private inFlight: Promise<SyncResult> | null = null;

  configure(settings: ServerControlSettings): void {
    const changed =
      this.settings?.url !== settings.url ||
      this.settings?.token !== settings.token ||
      this.settings?.enabled !== settings.enabled;
    this.settings = settings;
    if (!changed) return;

    this.client = null;
    this.error = null;
    this.health = null;
    this.resetStream();

    if (!settings.enabled || !settings.url || !settings.token) return;
    try {
      this.client = new ServerControlClient({ url: settings.url, token: settings.token });
    } catch (caught) {
      this.error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  private resetStream(): void {
    this.calls.clear();
    this.rules = [];
    this.pods.clear();
    this.processId = null;
    this.desired = null;
  }

  private pod(processId: string): Pod {
    let pod = this.pods.get(processId);
    if (!pod) {
      pod = { processId, cursor: 0, health: null, lastSeenAt: Date.now(), gap: false };
      this.pods.set(processId, pod);
    }
    return pod;
  }

  private livePods(now = Date.now()): Pod[] {
    return [...this.pods.values()].filter((pod) => now - pod.lastSeenAt <= POD_TTL_MS);
  }

  status(): ServerBridgeStatus {
    let endpoint: string | null = null;
    try {
      endpoint = this.settings?.url ? normalizeControlUrl(this.settings.url) : null;
    } catch {
      endpoint = null;
    }
    const pods = this.livePods();
    return {
      configured: Boolean(this.settings?.enabled && this.settings.url && this.settings.token),
      connected: this.client !== null && this.health !== null && this.error === null,
      endpoint,
      health: this.health,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      gap: pods.some((pod) => pod.gap),
      callCount: this.calls.size,
      ruleCount: this.rules.length,
      processId: this.processId,
      pods: pods.map((pod) => ({
        processId: pod.processId,
        serviceName: pod.health?.serviceName ?? null,
        lastSeenAt: pod.lastSeenAt,
        bufferedCalls: pod.health?.bufferedCalls ?? null,
        gap: pod.gap,
      })),
    };
  }

  snapshot(): ServerCall[] {
    return [...this.calls.values()].sort((left, right) => left.startedAt - right.startedAt || left.seq - right.seq);
  }

  spans(): TraceSpan[] {
    return this.snapshot().map(serverCallToSpan);
  }

  serverRules(): ServerMockRule[] {
    return [...this.rules];
  }

  /** Coalesces concurrent syncs so a fast poll interval cannot pile up requests. */
  sync(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runSync(): Promise<SyncResult> {
    if (!this.client) {
      return { status: this.status(), fresh: [], spans: [] };
    }

    try {
      const health = await this.client.health();
      if (health.protocolVersion !== 2) {
        throw new ServerControlError(
          `Server SDK speaks control protocol ${health.protocolVersion}; this extension speaks 2. Update whichever is older.`,
          null,
        );
      }
      const now = Date.now();
      const answered = this.pod(health.processId);
      answered.health = health;
      answered.lastSeenAt = now;
      this.processId = health.processId;
      this.health = health;

      // `since` is for SDKs older than 0.5, which ignore `cursors`.
      const cursors = new Map([...this.pods.values()].map((pod) => [pod.processId, pod.cursor] as const));
      const page = await this.client.calls(answered.cursor, 200, cursors);
      const source = this.pod(page.processId);
      source.lastSeenAt = now;

      const fresh: ServerCall[] = [];
      for (const call of page.calls) {
        // Pods number their calls independently; the span id is unique across them.
        if (this.calls.has(call.spanId)) continue;
        this.calls.set(call.spanId, call);
        fresh.push(call);
      }
      if (page.calls.length > 0) {
        source.cursor = Math.max(source.cursor, ...page.calls.map((call) => call.seq));
      }
      source.gap = page.gap;
      this.trim();

      const remote = await this.client.rules().catch(() => null);
      if (remote) await this.reconcileRules(remote.processId, remote.rules);

      this.error = null;
      this.lastSyncAt = Date.now();
      return { status: this.status(), fresh, spans: fresh.map(serverCallToSpan) };
    } catch (caught) {
      this.error = caught instanceof Error ? caught.message : String(caught);
      this.health = null;
      this.lastSyncAt = Date.now();
      return { status: this.status(), fresh: [], spans: [] };
    }
  }

  /**
   * A save reaches one pod. When a poll lands on a pod without this tester's
   * rules, they are pushed there too, unless that pod holds a later edit
   * (another tester), which then wins everywhere.
   */
  private async reconcileRules(processId: string, remote: ServerMockRule[]): Promise<void> {
    const desired = this.desired;
    if (!desired || ruleSignature(remote) === ruleSignature(desired.rules) || !this.client) {
      this.rules = remote;
      return;
    }
    if (newestEdit(remote) > desired.savedAt) {
      this.desired = null;
      this.rules = remote;
      return;
    }
    // The PUT may land on another pod than the GET did; a few tries reach the
    // one that was missing them (an extra copy elsewhere is harmless).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const saved = await this.client.setRules(desired.rules);
        this.rules = saved.rules;
        if (saved.processId === processId) return;
      } catch {
        this.rules = remote;
        return;
      }
    }
  }

  async pushRules(rules: ServerMockRule[]): Promise<ServerMockRule[]> {
    if (!this.client) throw new ServerControlError('No server control endpoint is configured.', null);
    const result = await this.client.setRules(rules);
    this.rules = result.rules;
    this.desired = { rules: result.rules, savedAt: Math.max(Date.now(), newestEdit(result.rules)) };
    this.error = null;
    return this.rules;
  }

  /**
   * Clears what this tester sees. Cursors are kept: seq keeps growing after a
   * server-side clear, and pods the DELETE did not reach must not be re-read.
   */
  async clear(): Promise<void> {
    this.calls.clear();
    for (const pod of this.pods.values()) pod.gap = false;
    if (this.client) await this.client.clearCalls().catch(() => undefined);
  }

  /** Verifies URL and token before the tester starts a session. */
  async test(settings: ServerControlSettings): Promise<ServerControlHealth> {
    const client = new ServerControlClient({ url: settings.url, token: settings.token });
    return client.health();
  }

  private trim(): void {
    if (this.calls.size <= MAX_CALLS) return;
    const excess = this.calls.size - MAX_CALLS;
    const keys = this.calls.keys();
    for (let index = 0; index < excess; index += 1) {
      const next = keys.next();
      if (next.done) break;
      this.calls.delete(next.value);
    }
  }
}
