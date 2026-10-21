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

export class ServerBridge {
  private settings: ServerControlSettings | null = null;
  private client: ServerControlClient | null = null;
  private readonly calls = new Map<string, ServerCall>();
  private rules: ServerMockRule[] = [];
  private cursor = 0;
  private processId: string | null = null;
  private health: ServerControlHealth | null = null;
  private error: string | null = null;
  private lastSyncAt: number | null = null;
  private gap = false;
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
    this.cursor = 0;
    this.processId = null;
    this.gap = false;
  }

  status(): ServerBridgeStatus {
    let endpoint: string | null = null;
    try {
      endpoint = this.settings?.url ? normalizeControlUrl(this.settings.url) : null;
    } catch {
      endpoint = null;
    }
    return {
      configured: Boolean(this.settings?.enabled && this.settings.url && this.settings.token),
      connected: this.client !== null && this.health !== null && this.error === null,
      endpoint,
      health: this.health,
      error: this.error,
      lastSyncAt: this.lastSyncAt,
      gap: this.gap,
      callCount: this.calls.size,
      ruleCount: this.rules.length,
      processId: this.processId,
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
      // A new process id means a redeploy or restart: old cursors are meaningless.
      if (this.processId && this.processId !== health.processId) this.resetStream();
      this.processId = health.processId;
      this.health = health;

      const page = await this.client.calls(this.cursor, 200);
      if (page.processId !== this.processId) {
        this.resetStream();
        this.processId = page.processId;
      }

      const fresh: ServerCall[] = [];
      for (const call of page.calls) {
        if (this.calls.has(call.spanId)) continue;
        this.calls.set(call.spanId, call);
        fresh.push(call);
      }
      if (page.calls.length > 0) {
        this.cursor = Math.max(this.cursor, ...page.calls.map((call) => call.seq));
      }
      this.gap = page.gap;
      this.trim();

      const remote = await this.client.rules().catch(() => null);
      if (remote) this.rules = remote.rules;

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

  async pushRules(rules: ServerMockRule[]): Promise<ServerMockRule[]> {
    if (!this.client) throw new ServerControlError('No server control endpoint is configured.', null);
    const result = await this.client.setRules(rules);
    this.rules = result.rules;
    this.error = null;
    return this.rules;
  }

  async clear(): Promise<void> {
    this.calls.clear();
    this.cursor = 0;
    this.gap = false;
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
