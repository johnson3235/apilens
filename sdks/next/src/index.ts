import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import {
  captureBytes,
  captureInitBody,
  captureMessageBody,
  resolveBodyCapture,
  settleCapture,
  type BodyCaptureConfig,
  type CaptureOutcome,
} from './bodies';
import { CallBuffer, DEFAULT_MAX_BUFFER_BYTES } from './buffer';
import { buildRulesRevision, controlMountPath, createControlHandler, isTokenAcceptable, MIN_TOKEN_LENGTH, parseExpiry } from './control';
import {
  BodyTap, clearRequestHook, decodeBody, nodeHeaders, setRequestHook, tapRequest, tapWrites, trackResponseHeaders, type RequestHook,
} from './incoming';
import {
  clearOutgoingHook, MockedClientRequest, realResponse, setOutgoingHook, simulatedConnectionError, unpatchedHttpRequest,
  type OutgoingCall, type OutgoingHook,
} from './outgoing';
import { applyFieldMutations, buildMockResponse, headerSafe, MockNetworkError, sanitizeRule, selectMockRule } from './mocks';
import { redactHeaders, safeUrlParts } from './redaction';
import { CONTROL_PROTOCOL_VERSION, MIDDLEWARE_HEADER } from './types';
import type {
  AutoInstrumentOptions,
  CapturedBody,
  CaptureStats,
  ConfigIssue,
  ControlHealth,
  ControlPlaneOptions,
  MockSkipReason,
  NextSDKOptions,
  ServerCall,
  ServerMockRule,
} from './types';

export * from './types';
export { DEFAULT_TEXT_CONTENT_TYPES } from './bodies';
export { MIN_TOKEN_LENGTH } from './control';

export const SDK_VERSION = '0.5.0';

/**
 * Session id used when `captureWithoutSession` is on.
 *
 * A shared dev deployment serves testers who cannot inject headers, so their
 * traffic is grouped here rather than discarded.
 */
export const AMBIENT_SESSION_ID = 'apilens-ambient';

/** Wire-compatible with ApiLens TraceSpan; no workspace runtime/type dependencies. */
export interface ServerSpan {
  traceId: string; spanId: string; parentSpanId: string | null; sessionId: string;
  serviceName: string; operationName: string; kind: 'server' | 'client';
  source: 'internal-service'; channel: 'server-sdk'; method: string; url: string;
  statusCode: number | null; status: 'ok' | 'error'; startedAt: number; endedAt: number;
  durationMs: number; attributes: Record<string, string | number | boolean>;
  events: never[]; error: string | null; mockedBy: string | null;
}

interface Context {
  sessionId: string; scenarioId?: string; traceId: string; spanId: string;
  /** Control endpoint to forward captures to, when this process relays (serverless). */
  relayTo: string | null;
  /** Set when the context was opened automatically for an incoming request. */
  auto?: AutoRequest;
  /** Shared by every context opened for one incoming request, including nested wrapRoute/traceRender. */
  lifecycle?: { finished: boolean };
  /** The Edge middleware run that let this request through. */
  middlewareSpanId?: string | null;
}

interface AutoRequest {
  method: string; url: string; headers: Headers; parentSpanId: string | null;
  /**
   * The live `req.headers`. Next applies a middleware's request-header
   * overrides to this object after the hook has run, so the middleware link
   * is read from here when calls are recorded.
   */
  live: IncomingMessage['headers'];
  /** A W3C traceparent wins over the middleware's trace. */
  tracedByParent: boolean;
  /** Outgoing calls made while handling it; requests with none are usually noise. */
  outbound: number;
  /** A `wrapRoute`/`traceRender` inside it records the call instead, with richer detail. */
  claimed: boolean;
  /** Relay rules are fetched once, and only when a call actually needs them. */
  rules?: Promise<void>;
}

const id = (bytes: number) => randomBytes(bytes).toString('hex');
const safeId = (value: string | null): string | undefined => value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

function parseMiddlewareLink(value: string | null): { traceId: string; spanId: string } | null {
  const link = /^([a-f0-9]{32})-([a-f0-9]{16})$/.exec(value ?? '');
  return link ? { traceId: link[1]!, spanId: link[2]! } : null;
}
/**
 * Continues the trace of the Edge middleware run that let this request
 * through. Middleware runs before the page renders, so by the time any call
 * of the page is recorded its override headers are in place.
 */
function adoptMiddlewareLink(ctx: Context): void {
  if (!ctx.auto || ctx.middlewareSpanId) return;
  const raw = ctx.auto.live[MIDDLEWARE_HEADER];
  const link = parseMiddlewareLink(typeof raw === 'string' ? raw : null);
  if (!link) return;
  ctx.middlewareSpanId = link.spanId;
  if (!ctx.auto.tracedByParent) ctx.traceId = link.traceId;
}
function parseTraceparent(value: string | null): { traceId: string; spanId: string } | null {
  const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value ?? '');
  return parent && !/^0+$/.test(parent[1]!) && !/^0+$/.test(parent[2]!) ? { traceId: parent[1]!, spanId: parent[2]! } : null;
}

/** Next's assets, dev tooling and the SDK's own control endpoint are never QA traffic. */
const ALWAYS_IGNORED = /^\/(?:_next\/|__nextjs|api\/(?:__|%5F_)apilens(?:\/|$)|favicon\.ico$)|\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|txt|xml|webmanifest)$/i;

/** Largest control-plane request body read by the request hook. */
const MAX_CONTROL_BODY_BYTES = 1024 * 1024;

/**
 * Tracer and telemetry agents. Their background flushes inherit whichever
 * request was in flight, so they would otherwise show up as that request's
 * backend calls.
 */
const DEFAULT_IGNORED_OUTGOING: (string | RegExp)[] = [':8126', ':4317', ':4318'];

function telemetryAgentsFromEnv(): string[] {
  const found: string[] = [];
  const host = process.env.DD_AGENT_HOST;
  if (host) found.push(`${host}:${process.env.DD_TRACE_AGENT_PORT || '8126'}`);
  if (process.env.DD_TRACE_AGENT_URL) found.push(process.env.DD_TRACE_AGENT_URL);
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) found.push(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  return found;
}

/**
 * Builds the outgoing ignore test. A string with a scheme is a URL prefix,
 * `:port` matches any host on that port, `host:port` the exact pair, and a
 * bare host that host or its subdomains.
 */
export function outgoingMatcher(rules: (string | RegExp)[]): (url: string) => boolean {
  const tests = rules.flatMap((rule): Array<(url: URL, raw: string) => boolean> => {
    if (rule instanceof RegExp) return [(_url, raw) => { rule.lastIndex = 0; return rule.test(raw); }];
    const value = String(rule).trim().toLowerCase();
    if (!value) return [];
    if (value.includes('://')) return [(_url, raw) => raw.toLowerCase().startsWith(value)];
    if (value.startsWith(':')) return [(url) => effectivePort(url) === value.slice(1)];
    if (value.includes(':') && !value.startsWith('[')) {
      const [host, port] = [value.slice(0, value.lastIndexOf(':')), value.slice(value.lastIndexOf(':') + 1)];
      return [(url) => url.hostname.toLowerCase() === host && effectivePort(url) === port];
    }
    return [(url) => url.hostname.toLowerCase() === value || url.hostname.toLowerCase().endsWith(`.${value}`)];
  });
  return (raw) => {
    if (tests.length === 0) return false;
    try {
      const url = new URL(raw);
      return tests.some((test) => test(url, raw));
    } catch {
      return false;
    }
  };
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
}

/** Page markup and RSC payloads are not data a tester inspects. */
const MARKUP_TYPES = /^(?:text\/html|text\/x-component)\b/i;

const isNextPatched = (candidate: typeof fetch): boolean =>
  (candidate as typeof fetch & { __nextPatched?: boolean }).__nextPatched === true;

export function safeHeaders(headers: Headers): Record<string, string> {
  return redactHeaders(headers);
}

function safeUrl(value: string): string {
  return safeUrlParts(value).url;
}

/** Local-only transport, authenticated /v1/spans, never uses instrumented fetch. */
class Reporter {
  private pending: ServerSpan[] = [];
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly diagnostics = { accepted: 0, dropped: 0, lastError: null as string | null };
  private readonly endpoint: URL | null;

  constructor(private readonly options: NextSDKOptions) {
    // A remote dev server's 127.0.0.1 is not the tester's laptop, so agent
    // delivery is skipped entirely there and the control plane is used instead.
    if (options.reportToAgent === false) {
      this.endpoint = null;
      return;
    }
    this.endpoint = new URL('/v1/spans', options.agentUrl ?? 'http://127.0.0.1:7317');
    if (this.endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(this.endpoint.hostname) || this.endpoint.username || this.endpoint.password) {
      throw new Error('ApiLens requires an HTTP loopback agent in this release. Set reportToAgent: false and use the control plane for remote servers.');
    }
  }

  get active$(): boolean { return this.endpoint !== null; }

  add(span: ServerSpan): void {
    if (!this.endpoint) return;
    if (this.pending.length >= 1000) { this.diagnostics.dropped++; return; }
    this.pending.push(span);
    if (!this.timer) { this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref(); }
  }

  async flush(): Promise<void> {
    if (!this.endpoint) return;
    if (this.active) { await this.active; return this.flush(); }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0, 100);
    this.active = (async () => {
      // Agent ingestion accepts one session per request; never mix concurrent testers.
      const groups = new Map<string, ServerSpan[]>();
      for (const span of batch) groups.set(span.sessionId, [...(groups.get(span.sessionId) ?? []), span]);
      for (const [sessionId, spans] of groups) {
        try {
          await this.send(JSON.stringify({ sessionId, spans }));
          this.diagnostics.accepted += spans.length; this.diagnostics.lastError = null;
        } catch (error) {
          this.diagnostics.dropped += spans.length;
          this.diagnostics.lastError = error instanceof Error ? error.message : 'Agent delivery failed';
        }
      }
    })();
    try { await this.active; } finally { this.active = null; }
    // Bounded flush: later calls flush requests that arrived during this batch.
  }

  private send(body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = unpatchedHttpRequest()(this.endpoint!, { method: 'POST', headers: {
        authorization: `Bearer ${this.options.agentToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      } }, (response) => {
        response.resume();
        response.on('error', () => reject(new Error('Agent response failed')));
        response.on('end', () => response.statusCode === 202 ? resolve() : reject(new Error(`Agent HTTP ${response.statusCode}`)));
      });
      const timeout = setTimeout(() => request.destroy(new Error('Agent delivery timed out')), 2000);
      timeout.unref();
      request.on('close', () => clearTimeout(timeout));
      request.on('error', () => reject(new Error('Agent unavailable or request timed out')));
      request.end(body);
    });
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
    while (this.pending.length) await this.flush();
  }
}

export class ApiLensNextSDK {
  private readonly contexts = new AsyncLocalStorage<Context>();
  private readonly insideFetch = new AsyncLocalStorage<boolean>();
  private readonly reporter: Reporter;
  private readonly buffer: CallBuffer;
  private readonly bodyCapture: BodyCaptureConfig;
  private readonly control: ReturnType<typeof createControlHandler> | null;
  private wrapper: typeof fetch | null = null;
  private downstream: typeof fetch | null = null;
  private stopped = false;
  private readonly allowed: Set<string>;
  private readonly allowAnyOrigin: boolean;
  private readonly propagate: Set<string>;
  private rules: ServerMockRule[] = [];
  private rulesRev = buildRulesRevision([]);
  /** Recording runs off the request's critical path; `flush()` drains it. */
  private readonly pendingRecords = new Set<Promise<void>>();
  /** Set once this process answers the extension: from then on it keeps calls itself. */
  private servedControl = false;
  private relayFailures = 0;
  private lastRelayError: string | null = null;
  private readonly auto: AutoInstrumentOptions | null;
  private requestHook: RequestHook | null = null;
  private outgoingHook: OutgoingHook | null = null;
  /** The control settings actually in force, after validation. */
  private readonly controlOptions: ControlPlaneOptions | null;
  private readonly controlPath: string;
  private readonly isIgnoredOutgoing: (url: string) => boolean;
  private readonly issues: ConfigIssue[] = [];
  private lateCallsSkipped = 0;
  private ignoredOutgoingCalls = 0;
  /** Outermost fetch layer, above Next's own patch, that notices cache hits. */
  private cacheLayer: { outer: typeof fetch; inner: () => typeof fetch } | null = null;
  /** Origins the extension reached the control plane through; requests there are this app's own. */
  private readonly learnedOrigins = new Set<string>();
  private readonly stats: Omit<CaptureStats, 'learnedOrigins'> = {
    installed: false,
    installedBy: null,
    requestsSeen: 0,
    requestsRecorded: 0,
    skipped: { ignoredPath: 0, noSession: 0, originNotAllowed: 0, noBackendCall: 0 },
    lastRejectedOrigin: null,
    backendCalls: 0,
    cacheHits: 0,
    middlewareRuns: 0,
    lastRequestAt: null,
  };

  /** Distinguishes a restarted server from an idle one in the extension. */
  readonly processId = id(8);
  readonly startedAt = Date.now();

  constructor(private readonly options: NextSDKOptions) {
    // Configuration problems never stop the application from booting: the
    // affected feature is switched off and the reason is reported through
    // `diagnostics.configIssues` and the control plane's health instead.
    const enabled = options.enabled === true;
    const flag = (setting: string, problem: string) => { if (enabled) this.issues.push({ setting, problem }); };

    // Defaults to on so an existing local setup keeps delivering spans; remote
    // deployments must opt out explicitly and use the control plane instead.
    let reportToAgent = options.reportToAgent !== false;
    if (reportToAgent && !options.agentToken) {
      if (options.reportToAgent === true || !options.control?.enabled) {
        flag('agentToken', 'Missing, so spans are not delivered to the local agent. Set reportToAgent: false to use the control plane only.');
      }
      reportToAgent = false;
    }

    let control: ControlPlaneOptions | null = options.control?.enabled ? options.control : null;
    if (control && !isTokenAcceptable(control.token)) {
      flag('control.token', `Missing or shorter than ${MIN_TOKEN_LENGTH} characters, so the control plane is off.`);
      control = null;
    }
    if (control && options.agentToken && control.token === options.agentToken) {
      flag('control.token', 'Equal to agentToken, so the control plane is off. A leaked control token must not reach the agent.');
      control = null;
    }
    const expiry = control ? parseExpiry(control.expiresAt) : null;
    if (control && expiry !== null && expiry <= Date.now()) {
      flag('control.expiresAt', 'Already passed (or unreadable), so the control plane answers 404. Issue a new token and expiry.');
    }
    this.controlOptions = control;
    this.controlPath = controlMountPath(control?.path);

    this.allowAnyOrigin = options.allowedAppOrigins.includes('*');
    const origins = new Set<string>();
    for (const origin of options.allowedAppOrigins) {
      if (origin === '*') continue;
      try { origins.add(new URL(origin).origin); } catch { flag('allowedAppOrigins', `"${origin}" is not a URL origin and is ignored.`); }
    }
    this.allowed = origins;
    const propagate = new Set<string>();
    for (const origin of options.propagateToOrigins ?? []) {
      try { propagate.add(new URL(origin).origin); } catch { flag('propagateToOrigins', `"${origin}" is not a URL origin and is ignored.`); }
    }
    this.propagate = propagate;
    this.bodyCapture = resolveBodyCapture(options.captureBodies);
    this.buffer = new CallBuffer(
      Math.max(50, Math.min(control?.bufferSize ?? 500, 5_000)),
      Math.max(1024 * 1024, Math.min(control?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES, 512 * 1024 * 1024)),
    );
    let reporter: Reporter;
    try {
      reporter = new Reporter({ ...options, reportToAgent });
    } catch (cause) {
      flag('agentUrl', `${cause instanceof Error ? cause.message : 'Invalid agent URL'} Agent delivery is off.`);
      reporter = new Reporter({ ...options, reportToAgent: false });
    }
    this.reporter = reporter;
    this.auto = options.autoInstrument === false ? null : options.autoInstrument === true || !options.autoInstrument ? {} : options.autoInstrument;
    this.isIgnoredOutgoing = outgoingMatcher([
      ...DEFAULT_IGNORED_OUTGOING,
      ...telemetryAgentsFromEnv(),
      ...(options.ignoreOutgoing ?? []),
      ...(this.auto?.ignoreOutgoing ?? []),
    ]);

    this.control = control
      ? createControlHandler({
          options: control,
          processId: this.processId,
          buffer: this.buffer,
          health: () => this.health(),
          getRules: () => this.rules,
          setRules: (rules) => this.applyRules(rules),
          rulesRevision: () => this.rulesRev,
          clearCalls: () => this.buffer.clear(),
          ingest: (calls) => this.ingestRelayed(calls),
          consume: (ruleIds) => {
            for (const rule of this.rules) if (ruleIds.includes(rule.id)) rule.appliedCount += 1;
          },
        })
      : null;

    if (this.issues.length) {
      // Names the setting and the problem only; never a token or its length.
      console.warn(`[apilens] ${this.issues.map((issue) => `${issue.setting}: ${issue.problem}`).join(' | ')}`);
    }
  }

  get diagnostics() {
    return {
      ...this.reporter.diagnostics,
      relayFailures: this.relayFailures,
      lastRelayError: this.lastRelayError,
      configIssues: [...this.issues],
      lateCallsSkipped: this.lateCallsSkipped,
      ignoredOutgoingCalls: this.ignoredOutgoingCalls,
    };
  }
  get enabled(): boolean { return this.options.enabled === true && !this.stopped; }
  /** True when the extension can reach this process over the control plane. */
  get controlEnabled(): boolean { return this.control !== null && this.enabled; }

  health(): ControlHealth {
    return {
      ok: true,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      sdkVersion: SDK_VERSION,
      serviceName: this.options.serviceName,
      processId: this.processId,
      startedAt: this.startedAt,
      enabled: this.enabled,
      captureRequestBodies: this.bodyCapture.request,
      captureResponseBodies: this.bodyCapture.response,
      maxBodyBytes: this.bodyCapture.maxBytes,
      mockingEnabled: this.controlOptions?.allowMockControl !== false,
      routeMocksEnabled: this.options.allowRouteMocks === true,
      bufferedCalls: this.buffer.size(),
      latestSeq: this.buffer.latestSeq(),
      droppedCalls: this.buffer.droppedCount(),
      bufferedBytes: this.buffer.byteSize(),
      maxBufferBytes: this.buffer.byteLimit(),
      configIssues: [...this.issues],
      ruleCount: this.rules.length,
      activeRuleCount: this.rules.filter((rule) => rule.enabled).length,
      agentDelivery: { ...this.reporter.diagnostics },
      capture: { ...this.stats, skipped: { ...this.stats.skipped }, learnedOrigins: [...this.learnedOrigins] },
    };
  }

  /** Calls captured so far, newest last. Useful for assertions in automated tests. */
  calls(): ServerCall[] { return this.buffer.all(); }
  clearCalls(): void { this.buffer.clear(); }
  serverMockRules(): ServerMockRule[] { return [...this.rules]; }

  /** Replaces the active server mock rules, normalising anything untrusted. */
  setServerMockRules(rules: unknown[]): ServerMockRule[] {
    const now = Date.now();
    this.applyRules(rules.map((rule) => sanitizeRule(rule, now)).filter((rule): rule is ServerMockRule => rule !== null));
    return this.serverMockRules();
  }

  private applyRules(rules: ServerMockRule[]): void {
    this.rules = rules;
    this.rulesRev = buildRulesRevision(rules);
  }

  /**
   * Handles one control-plane request.
   *
   * Mount from a catch-all Node-runtime route such as
   * `src/app/api/%5F_apilens/[[...segments]]/route.ts` (served at `/api/__apilens`;
   * a folder starting with `_` is private in the App Router and never routed).
   */
  async handleControlRequest(request: Request): Promise<Response> {
    if (!this.control) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const response = await this.control(request);
    if (response.status < 400) {
      this.servedControl = true;
      this.learnOrigin(request);
      if (this.enabled && !this.stats.installed && !this.controlOptions?.relay) {
        // register() never ran (on Next 14, usually a missing
        // experimental.instrumentationHook), so capture starts from here.
        this.installFetch('first-connection');
        this.issues.push({
          setting: 'instrumentation',
          problem: 'install() was not called at boot, so ApiLens installed itself when the extension first connected and earlier requests were missed. Call apiLens.install() from register() in instrumentation.ts (Next 14: experimental.instrumentationHook: true).',
        });
      }
    }
    return response;
  }

  /**
   * The extension reached the control plane through this origin with a valid
   * token, so pages served there are this application's own, even when the
   * ingress rewrites the host away from `allowedAppOrigins`.
   */
  private learnOrigin(request: Request): void {
    if (this.learnedOrigins.size >= 20) return;
    const candidates = [request.url];
    try { candidates.push(renderUrl(new URL(request.url).pathname, request.headers)); } catch { /* request.url alone */ }
    for (const candidate of candidates) {
      try {
        const origin = new URL(candidate).origin;
        if (origin !== 'null' && !this.allowed.has(origin)) this.learnedOrigins.add(origin);
      } catch { /* not a URL */ }
    }
  }

  /** Ready-made App Router exports for the control route file. */
  controlRoute(): {
    GET: (request: Request) => Promise<Response>;
    POST: (request: Request) => Promise<Response>;
    PUT: (request: Request) => Promise<Response>;
    DELETE: (request: Request) => Promise<Response>;
    OPTIONS: (request: Request) => Promise<Response>;
  } {
    const handle = (request: Request): Promise<Response> => this.handleControlRequest(request);
    return { GET: handle, POST: handle, PUT: handle, DELETE: handle, OPTIONS: handle };
  }

  private isControlPath(pathname: string): boolean {
    const mount = this.controlPath;
    if (pathname === mount || pathname.startsWith(`${mount}/`)) return true;
    // The App Router folder for the default mount is `%5F_apilens`; accept either spelling.
    return mount === '/api/__apilens' && /^\/api\/%5F_apilens(?:\/|$)/i.test(pathname);
  }

  /**
   * Answers the control plane straight from the request hook, before Next
   * routes the request, so the application needs no control route file.
   */
  private async serveControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const headers = nodeHeaders(req.headers);
      const method = (req.method ?? 'GET').toUpperCase();
      let body: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          size += bytes.byteLength;
          if (size > MAX_CONTROL_BODY_BYTES) {
            res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ error: 'Control request body too large.' }));
            return;
          }
          chunks.push(bytes);
        }
        body = Buffer.concat(chunks);
      }
      const response = await this.handleControlRequest(new Request(renderUrl(req.url ?? '/', headers), { method, headers, body }));
      const outgoing: Record<string, string> = {};
      response.headers.forEach((value, name) => { outgoing[name] = value; });
      const payload = Buffer.from(await response.arrayBuffer());
      outgoing['content-length'] = String(payload.byteLength);
      res.writeHead(response.status, outgoing);
      res.end(method === 'HEAD' ? undefined : payload);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'Control request failed.' }));
    }
  }

  /**
   * Turns capture on for the whole server. Call once from `register()` in
   * instrumentation.ts; no page, layout or route file needs to change.
   */
  install(): void {
    this.installFetch();
  }

  /** Same as `install()`; kept for 0.2 integrations, which already call it at boot. */
  installFetch(by: 'boot' | 'first-connection' = 'boot'): void {
    if (!this.enabled) return;
    if (!this.stats.installed) {
      this.stats.installed = true;
      this.stats.installedBy = by;
    }
    if ((this.auto || (this.control && !this.controlOptions?.relay)) && !this.requestHook) {
      this.requestHook = (req, res, dispatch) => this.onIncoming(req, res, dispatch);
      setRequestHook(this.requestHook);
    }
    if (this.options.captureNodeHttp !== false && !this.outgoingHook) {
      this.outgoingHook = (call, original) => this.onOutgoing(call, original);
      setOutgoingHook(this.outgoingHook);
    }
    if (this.cacheLayer && globalThis.fetch === this.cacheLayer.outer) return;
    // Next wraps fetch once and marks it; wrapping on top of that again would
    // make Next wrap again, growing the chain on every request.
    if (globalThis.fetch === this.wrapper || (this.wrapper && isNextPatched(globalThis.fetch))) return;
    const downstream = globalThis.fetch;
    const sdk = this;
    this.downstream = downstream;
    this.wrapper = function apiLensFetch(input, init) {
      const ctx = sdk.contexts.getStore();
      if (!sdk.enabled || !ctx || sdk.insideFetch.getStore()) return downstream(input, init);
      if (sdk.skipOutgoing(ctx, fetchUrl(input))) return downstream(input, init);
      return sdk.insideFetch.run(true, () => sdk.instrumentedFetch(downstream, ctx, input, init));
    };
    if (!this.installCacheLayer(this.wrapper)) globalThis.fetch = this.wrapper;
  }

  /**
   * Puts a layer above whatever later replaces `globalThis.fetch`.
   *
   * Next (and React's request deduplication) patch fetch after boot and answer
   * cached calls themselves, so the wrapper below them never sees those. The
   * global becomes an accessor: assignments land underneath this layer, which
   * calls through them and records a call as a cache hit when it came back
   * without ever reaching the network wrapper. When the patch calls down to
   * the fetch it captured (this layer), the call goes straight to `base`.
   */
  private installCacheLayer(base: typeof fetch): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    if (!descriptor?.configurable || !('value' in descriptor)) return false;
    const sdk = this;
    const passing = new AsyncLocalStorage<{ reached: boolean }>();
    let inner: typeof fetch = base;
    const target = (() => undefined) as unknown as typeof fetch;
    const outer = new Proxy(target, {
      apply(_target, thisArg, args: [RequestInfo | URL, RequestInit | undefined]) {
        const below = passing.getStore();
        if (below) {
          below.reached = true;
          return base.apply(thisArg, args);
        }
        if (inner === base || sdk.stopped) return base.apply(thisArg, args);
        const state = { reached: false };
        const startedAt = Date.now();
        const result = passing.run(state, () => inner.apply(thisArg, args));
        const ctx = sdk.contexts.getStore();
        if (!ctx || !sdk.enabled || sdk.insideFetch.getStore()) return result;
        return Promise.resolve(result).then((response) => {
          if (!state.reached && response instanceof Response) {
            try { sdk.recordCacheHit(ctx, args[0], args[1], response, startedAt); } catch { /* capture is best-effort */ }
          }
          return response;
        });
      },
      // Next reads and writes markers such as `__nextPatched` on the global fetch.
      get: (_target, property) => Reflect.get(inner, property),
      set: (_target, property, value) => Reflect.set(inner, property, value),
      has: (_target, property) => Reflect.has(inner, property),
    });
    try {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        enumerable: descriptor.enumerable ?? true,
        get: () => outer,
        set: (value: typeof fetch) => {
          // Code that saves and restores the global must not put this layer under itself.
          if (typeof value === 'function' && value !== outer) inner = value;
        },
      });
    } catch {
      return false;
    }
    this.cacheLayer = { outer, inner: () => inner };
    return true;
  }

  /** A fetch Next answered from its cache: no backend call happened, but the page got this data. */
  private recordCacheHit(ctx: Context, input: RequestInfo | URL, init: RequestInit | undefined, response: Response, startedAt: number): void {
    const url = fetchUrl(input);
    if (this.skipOutgoing(ctx, url)) return;
    const requestInput = input instanceof Request ? input : null;
    const method = (init?.method ?? requestInput?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? requestInput?.headers);
    if (ctx.auto) ctx.auto.outbound += 1;
    this.stats.cacheHits += 1;
    const requestCapture = this.bodyCapture.request && init?.body !== undefined && init?.body !== null
      ? captureInitBody(init.body, headers.get('content-type'), this.bodyCapture)
      : null;
    const responseCapture = this.bodyCapture.response ? captureMessageBody(response, this.bodyCapture) : null;
    this.track(this.finishRecord({
      ctx, spanId: id(8), parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
      statusCode: response.status, requestHeaders: headers, responseHeaders: response.headers,
      error: null, requestCapture, responseCapture, mockedBy: null, skipped: [], cache: 'hit',
    }));
  }

  /**
   * True for calls that are passed through untouched: tracer and agent
   * traffic, configured ignores, and background work that only inherited the
   * context of a request whose response has already been sent.
   */
  private skipOutgoing(ctx: Context, url: string): boolean {
    if (this.isIgnoredOutgoing(url)) {
      this.ignoredOutgoingCalls += 1;
      return true;
    }
    if (ctx.lifecycle?.finished && !this.auto?.recordAfterResponse) {
      this.lateCallsSkipped += 1;
      return true;
    }
    return false;
  }

  /** Opens a capture context around one incoming request; never lets a failure reach the app. */
  private onIncoming(req: IncomingMessage, res: ServerResponse, dispatch: () => boolean): boolean {
    // Relay mode (serverless) keeps the route file as the one store the extension polls.
    if (this.control && this.enabled && !this.controlOptions?.relay) {
      let pathname = '/';
      try { pathname = (req.url ?? '/').split('?')[0]!; } catch { /* treat as root */ }
      if (this.isControlPath(pathname)) {
        void this.serveControl(req, res);
        return true;
      }
    }
    if (!this.auto) return dispatch();
    let ctx: Context | null = null;
    try {
      ctx = this.enabled ? this.autoContext(req) : null;
    } catch {
      ctx = null;
    }
    if (!ctx) return dispatch();
    const opened = ctx;
    return this.contexts.run(opened, () => {
      try { this.observe(opened, req, res); } catch { /* capture is best-effort */ }
      return dispatch();
    });
  }

  private autoContext(req: IncomingMessage): Context | null {
    const rawPath = req.url ?? '/';
    const pathname = rawPath.split('?')[0]!;
    if (ALWAYS_IGNORED.test(pathname) || this.isControlPath(pathname)) return null;
    this.stats.requestsSeen += 1;
    this.stats.lastRequestAt = Date.now();
    if (this.auto?.ignorePaths?.some((rule) => typeof rule === 'string' ? pathname.startsWith(rule) : rule.test(pathname))) {
      this.stats.skipped.ignoredPath += 1;
      return null;
    }

    const headers = nodeHeaders(req.headers);
    const sessionId = safeId(headers.get('x-qa-session-id')) ?? (this.options.captureWithoutSession ? AMBIENT_SESSION_ID : undefined);
    if (!sessionId) {
      this.stats.skipped.noSession += 1;
      return null;
    }

    const parsed = new URL(renderUrl(rawPath, headers));
    parsed.searchParams.delete('_rsc'); // Next's cache-buster, not part of the page address.
    const url = parsed.toString();
    if (!this.originAllowed(url)) {
      this.stats.skipped.originNotAllowed += 1;
      this.stats.lastRejectedOrigin = parsed.origin;
      return null;
    }
    this.installFetch();

    const parent = parseTraceparent(headers.get('traceparent'));
    const ctx: Context = {
      sessionId,
      scenarioId: safeId(headers.get('x-test-scenario-id')),
      traceId: parent?.traceId ?? id(16),
      spanId: id(8),
      relayTo: this.relayTarget(url),
      auto: {
        method: (req.method ?? 'GET').toUpperCase(), url, headers, parentSpanId: parent?.spanId ?? null, outbound: 0, claimed: false,
        live: req.headers, tracedByParent: parent !== null,
      },
      lifecycle: { finished: false },
      middlewareSpanId: null,
    };
    adoptMiddlewareLink(ctx);
    return ctx;
  }

  /** Records the request once the response is done, off the request's critical path. */
  private observe(ctx: Context, req: IncomingMessage, res: ServerResponse): void {
    const auto = ctx.auto!;
    const startedAt = Date.now();
    const cap = this.bodyCapture.maxBytes;
    const requestTap = this.bodyCapture.request && cap > 0 ? tapRequest(req, cap) : null;
    const responseTap = this.bodyCapture.response && cap > 0 ? tapWrites(res, cap) : null;
    const sentHeaders = trackResponseHeaders(res);

    let settled = false;
    const finish = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      if (ctx.lifecycle) ctx.lifecycle.finished = true;
      const statusCode = aborted && !res.headersSent ? null : res.statusCode;
      if (auto.claimed) {
        this.stats.requestsRecorded += 1;
        return;
      }
      if (!this.worthRecording(auto, statusCode, aborted)) {
        this.stats.skipped.noBackendCall += 1;
        return;
      }
      this.stats.requestsRecorded += 1;
      const responseHeaders = sentHeaders();
      this.track(this.finishRecord({
        ctx, spanId: ctx.spanId, parentSpanId: auto.parentSpanId, kind: 'server', method: auto.method, url: auto.url, startedAt,
        statusCode, requestHeaders: auto.headers, responseHeaders,
        error: aborted ? 'ClientAborted' : null,
        requestCapture: requestTap ? this.tapped(requestTap, auto.headers) : null,
        responseCapture: responseTap ? this.tapped(responseTap, responseHeaders) : null,
        mockedBy: null, skipped: [],
      }));
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));
  }

  private worthRecording(auto: AutoRequest, statusCode: number | null, aborted: boolean): boolean {
    if (this.auto?.recordAllRequests || auto.outbound > 0 || aborted || statusCode === null || statusCode >= 400) return true;
    if (auto.method !== 'GET' && auto.method !== 'HEAD') return true; // server actions, form posts, mutations
    try { return new URL(auto.url).pathname.startsWith('/api/'); } catch { return false; }
  }

  /**
   * Captures a call made through Node's `http`/`https` client (axios, got…).
   *
   * Without a matching mock the caller gets the real `ClientRequest`, only
   * observed: no listener is added, so Node's own handling of unread
   * responses and unhandled errors is unchanged.
   */
  private onOutgoing(call: OutgoingCall, original: (...args: unknown[]) => ClientRequest): ClientRequest {
    const ctx = this.contexts.getStore();
    // insideFetch: a fetch polyfill built on http.request is already being captured.
    if (!this.enabled || !ctx || this.insideFetch.getStore()) return original(...call.args);
    if (this.skipOutgoing(ctx, call.url)) return original(...call.args);

    const spanId = id(8);
    const startedAt = Date.now();
    let decision: { rule: ServerMockRule | null; skipped: MockSkipReason[] } = { rule: null, skipped: [] };
    try {
      if (ctx.auto) {
        ctx.auto.outbound += 1;
        // Cannot wait here, so the first call of a relayed request uses the rules already held.
        if (ctx.relayTo) ctx.auto.rules ??= this.pullRules(ctx.relayTo);
      }
      decision = this.pick('client', call.method, call.url, call.headers, ctx, null);
    } catch {
      decision = { rule: null, skipped: [] };
    }

    if (decision.rule) return this.mockedOutgoing(decision.rule, decision.skipped, call, original, ctx, spanId, startedAt) as unknown as ClientRequest;

    const request = original(...call.args);
    try {
      this.observeOutgoing(request, call, ctx, spanId, startedAt, decision.skipped);
    } catch {
      // Capture is best-effort; the request itself is already on its way.
    }
    return request;
  }

  private observeOutgoing(
    request: ClientRequest, call: OutgoingCall, ctx: Context, spanId: string, startedAt: number, skipped: MockSkipReason[],
  ): void {
    try {
      if (this.propagate.has(new URL(call.url).origin) && !request.headersSent) {
        request.setHeader('traceparent', `00-${ctx.traceId}-${spanId}-01`);
        request.setHeader('x-qa-session-id', ctx.sessionId);
        if (ctx.scenarioId) request.setHeader('x-test-scenario-id', ctx.scenarioId);
      }
    } catch {
      // A URL that does not parse never matches a propagation origin.
    }

    const cap = this.bodyCapture.maxBytes;
    const requestTap = this.bodyCapture.request && cap > 0 ? tapWrites(request, cap) : null;
    const tapResponses = this.bodyCapture.response && cap > 0;
    let responseTap: BodyTap | null = null;
    let response: IncomingMessage | null = null;
    // Snapshot on arrival: clients such as axios delete content-encoding once they decompress.
    let responseHeaders: Headers | null = null;
    let settled = false;

    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      const requestHeaders = nodeHeaders(request.getHeaders());
      this.track(this.finishRecord({
        ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method: call.method, url: call.url, startedAt,
        statusCode: response?.statusCode ?? null, requestHeaders, responseHeaders, error,
        requestCapture: requestTap ? this.tapped(requestTap, requestHeaders, false) : null,
        responseCapture: responseTap && responseHeaders ? this.tapped(responseTap, responseHeaders, false) : null,
        mockedBy: null, skipped,
      }));
    };

    // Events are observed by wrapping emit: adding listeners would change how
    // Node treats an unread response or an unhandled error.
    const emitRequest = request.emit;
    request.emit = function apiLensRequestEmit(this: ClientRequest, event: string | symbol, ...args: unknown[]) {
      try {
        if (event === 'response' && !response) {
          response = args[0] as IncomingMessage;
          responseHeaders = nodeHeaders(response.headers);
          if (tapResponses) responseTap = tapRequest(response, cap);
          const emitResponse = response.emit;
          response.emit = function apiLensResponseEmit(this: IncomingMessage, inner: string | symbol, ...innerArgs: unknown[]) {
            try {
              if (inner === 'end') finish(null);
              else if (inner === 'error') finish(errorName(innerArgs[0]));
              else if (inner === 'close' || inner === 'aborted') finish(this.complete ? null : 'ResponseAborted');
            } catch { /* never break the response */ }
            return emitResponse.call(this, inner, ...innerArgs);
          } as IncomingMessage['emit'];
        } else if (event === 'error') {
          finish(errorName(args[0]));
        } else if (event === 'close' && !response) {
          finish('RequestAborted');
        }
      } catch { /* never break the request */ }
      return emitRequest.call(this, event, ...args);
    } as ClientRequest['emit'];
  }

  /** A request answered (or failed, or rewritten) by a server mock rule. */
  private mockedOutgoing(
    rule: ServerMockRule, skipped: MockSkipReason[], call: OutgoingCall, original: (...args: unknown[]) => ClientRequest,
    ctx: Context, spanId: string, startedAt: number,
  ): MockedClientRequest {
    const request: MockedClientRequest = new MockedClientRequest(call, async (body, signal) => {
      const headers = request.currentHeaders();
      const cap = this.bodyCapture.maxBytes;
      const requestCapture = this.bodyCapture.request && cap > 0
        ? Promise.resolve(captureBytes(body.subarray(0, cap), body.byteLength > cap, headers.get('content-type'), this.bodyCapture))
        : null;
      const real = () => realResponse(original, call, body, signal);

      if (rule.action.type === 'passthrough-mutate') {
        let upstream: Response;
        try {
          upstream = await real();
        } catch (cause) {
          this.track(this.finishRecord({
            ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method: call.method, url: call.url, startedAt,
            statusCode: null, requestHeaders: headers, responseHeaders: null, error: errorName(cause),
            requestCapture, responseCapture: null, mockedBy: null, skipped,
          }));
          throw cause;
        }
        return this.mutatePassthrough(rule, skipped, upstream, ctx, spanId, call.method, call.url, headers, startedAt, requestCapture);
      }

      try {
        return await this.serveMock(rule, skipped, ctx, spanId, call.method, call.url, headers, startedAt, requestCapture, signal, real);
      } catch (cause) {
        throw cause instanceof MockNetworkError ? simulatedConnectionError(cause.ruleName) : cause;
      }
    });
    return request;
  }

  private async tapped(tap: BodyTap, headers: Headers, skipMarkup = true): Promise<CaptureOutcome> {
    if (tap.size === 0) return { body: null, omitted: tap.truncated ? 'Body capture cap is 0 bytes' : null };
    const contentType = headers.get('content-type');
    if (skipMarkup && contentType && MARKUP_TYPES.test(contentType)) return { body: null, omitted: 'Not captured: page markup' };
    const encoding = headers.get('content-encoding');
    const decoded = await decodeBody(tap.bytes(), encoding, this.bodyCapture.maxBytes);
    if (!decoded) return { body: null, omitted: `Not captured: ${encoding} body could not be decoded` };
    const truncated = tap.truncated || decoded.byteLength > this.bodyCapture.maxBytes;
    return captureBytes(decoded.subarray(0, this.bodyCapture.maxBytes), truncated, contentType, this.bodyCapture);
  }

  private async instrumentedFetch(
    downstream: typeof fetch,
    ctx: Context,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const requestInput = input instanceof Request ? input : null;
    const url = requestInput?.url ?? String(input);
    const method = (init?.method ?? requestInput?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? requestInput?.headers);
    const spanId = id(8);
    const startedAt = Date.now();
    const signal = init?.signal ?? requestInput?.signal ?? null;
    if (ctx.auto) {
      ctx.auto.outbound += 1;
      if (ctx.relayTo) await (ctx.auto.rules ??= this.pullRules(ctx.relayTo));
    }

    // Cloning happens before the request is dispatched; the caller's own body
    // stream is never touched.
    const requestCapture = this.bodyCapture.request
      ? init?.body !== undefined && init?.body !== null
        ? captureInitBody(init.body, headers.get('content-type'), this.bodyCapture)
        : requestInput
          ? captureMessageBody(requestInput, this.bodyCapture)
          : null
      : null;

    const decision = await this.decide('client', method, url, headers, ctx, requestCapture);
    if (decision.rule && decision.rule.action.type !== 'passthrough-mutate') {
      return this.serveMock(
        decision.rule, decision.skipped, ctx, spanId, method, url, headers, startedAt, requestCapture, signal,
        () => downstream(input, init),
      );
    }

    let outgoing = init;
    try {
      if (this.propagate.has(new URL(url).origin)) {
        headers.set('traceparent', `00-${ctx.traceId}-${spanId}-01`);
        headers.set('x-qa-session-id', ctx.sessionId);
        if (ctx.scenarioId) headers.set('x-test-scenario-id', ctx.scenarioId);
        outgoing = { ...init, headers }; // Keep body, signal, cache, next and duplex untouched.
      }
    } catch {
      // A non-absolute URL simply never matches a propagation origin.
    }

    let response: Response;
    try {
      response = await downstream(input, outgoing);
    } catch (cause) {
      this.track(this.finishRecord({
        ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
        statusCode: null, requestHeaders: headers, responseHeaders: null,
        error: cause instanceof Error ? cause.name : 'FetchError',
        requestCapture, responseCapture: null, mockedBy: null, skipped: decision.skipped,
      }));
      throw cause;
    }

    if (decision.rule) {
      return this.mutatePassthrough(decision.rule, decision.skipped, response, ctx, spanId, method, url, headers, startedAt, requestCapture);
    }

    const responseCapture = this.bodyCapture.response ? captureMessageBody(response, this.bodyCapture) : null;
    this.track(this.finishRecord({
      ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
      statusCode: response.status, requestHeaders: headers, responseHeaders: response.headers,
      error: null, requestCapture, responseCapture, mockedBy: null, skipped: decision.skipped,
    }));
    return response;
  }

  /** Preserves NextRequest and params context. */
  wrapRoute<R extends Request, C>(handler: (request: R, context: C) => Response | Promise<Response>): (request: R, context: C) => Promise<Response> {
    return async (request, context) => {
      const headerSession = safeId(request.headers.get('x-qa-session-id'));
      const sessionId = headerSession ?? (this.options.captureWithoutSession ? AMBIENT_SESSION_ID : undefined);
      if (!this.enabled || !sessionId || !this.originAllowed(request.url)) return handler(request, context);
      this.installFetch();
      const outer = this.contexts.getStore();
      if (outer?.auto) outer.auto.claimed = true;
      if (outer) adoptMiddlewareLink(outer);

      const validParent = parseTraceparent(request.headers.get('traceparent'));
      const relayTo = this.relayTarget(request.url);
      if (relayTo) await this.pullRules(relayTo);
      const ctx: Context = { sessionId, scenarioId: safeId(request.headers.get('x-test-scenario-id')), traceId: validParent?.traceId ?? outer?.traceId ?? id(16), spanId: outer?.auto ? outer.spanId : id(8), relayTo, lifecycle: outer?.lifecycle, middlewareSpanId: outer?.middlewareSpanId ?? null };
      const startedAt = Date.now();
      const method = request.method.toUpperCase();

      return this.contexts.run(ctx, async () => {
        const requestCapture = this.bodyCapture.request ? captureMessageBody(request, this.bodyCapture) : null;

        if (this.options.allowRouteMocks) {
          const decision = await this.decide('server', method, request.url, request.headers, ctx, requestCapture);
          if (decision.rule && decision.rule.action.type !== 'passthrough-mutate') {
            return this.serveMock(
              decision.rule, decision.skipped, ctx, ctx.spanId, method, request.url, request.headers, startedAt, requestCapture,
              request.signal ?? null,
              async () => handler(request, context),
            );
          }
        }

        let response: Response | undefined;
        let error: string | null = null;
        try {
          response = await handler(request, context);
          return response;
        } catch (cause) {
          error = cause instanceof Error ? cause.name : 'HandlerError';
          throw cause;
        } finally {
          const responseCapture = response && this.bodyCapture.response ? captureMessageBody(response, this.bodyCapture) : null;
          this.track(this.finishRecord({
            ctx, spanId: ctx.spanId, parentSpanId: validParent?.spanId ?? null, kind: 'server', method,
            url: request.url, startedAt, statusCode: response?.status ?? null,
            requestHeaders: request.headers, responseHeaders: response?.headers ?? null,
            error, requestCapture, responseCapture, mockedBy: null, skipped: [],
          }));
        }
      });
    };
  }

  /**
   * Captures server-side rendering work as a page call.
   *
   * Server Components, `generateMetadata` and server actions have no Request
   * for `wrapRoute` to wrap, so the backend fetches they make would otherwise
   * go uncaptured — and the browser never sees them either. Run the data
   * loading inside `traceRender` and each fetch becomes a backend call under
   * one page call:
   *
   *   const data = await apiLens.traceRender(
   *     { path: `/myaccount/billing?contactId=${id}`, headers: headers() },
   *     () => loadBilling(id),
   *   );
   *
   * `headers` (from `next/headers`) supplies the host, the QA session and the
   * incoming trace. A plain-object or array result is captured as the page
   * call's "Received" body. Next's redirect/notFound signals are recorded as
   * 307/404, not failures. Server mocks apply to the backend calls inside;
   * the render itself is never mocked.
   */
  async traceRender<T>(
    page: string | { path: string; method?: string; headers?: Headers | null },
    render: () => T | Promise<T>,
  ): Promise<T> {
    const options = typeof page === 'string' ? { path: page } : page;
    const incoming = options.headers ?? null;
    const headerSession = safeId(incoming?.get('x-qa-session-id') ?? null);
    const sessionId = headerSession ?? (this.options.captureWithoutSession ? AMBIENT_SESSION_ID : undefined);
    // Nested renders (a layout and its page, say) stay one page call. An
    // automatic request context is the exception: the explicit call refines it.
    const outer = this.contexts.getStore();
    if (!this.enabled || !sessionId || (outer && !outer.auto)) return render();

    const url = renderUrl(options.path, incoming);
    if (!this.originAllowed(url)) return render();
    this.installFetch();
    if (outer?.auto) outer.auto.claimed = true;
    if (outer) adoptMiddlewareLink(outer);

    const validParent = parseTraceparent(incoming?.get('traceparent') ?? null);
    const relayTo = this.relayTarget(url);
    if (relayTo) await this.pullRules(relayTo);
    const ctx: Context = { sessionId, scenarioId: safeId(incoming?.get('x-test-scenario-id') ?? null), traceId: validParent?.traceId ?? outer?.traceId ?? id(16), spanId: outer?.auto ? outer.spanId : id(8), relayTo, lifecycle: outer?.lifecycle, middlewareSpanId: outer?.middlewareSpanId ?? null };
    const method = (options.method ?? 'GET').toUpperCase();
    const startedAt = Date.now();

    return this.contexts.run(ctx, async () => {
      let statusCode: number | null = 200;
      let error: string | null = null;
      let result: T | undefined;
      let record = true;
      try {
        result = await render();
        return result;
      } catch (cause) {
        const digest = typeof (cause as { digest?: unknown })?.digest === 'string' ? (cause as { digest: string }).digest : '';
        if (digest.startsWith('NEXT_REDIRECT')) statusCode = 307;
        else if (digest === 'NEXT_NOT_FOUND') statusCode = 404;
        else if (digest === 'DYNAMIC_SERVER_USAGE' || digest.startsWith('NEXT_')) record = false;
        else {
          statusCode = 500;
          error = cause instanceof Error ? cause.name : 'RenderError';
        }
        throw cause;
      } finally {
        if (record) {
          const responseCapture = this.bodyCapture.response && isPlainData(result)
            ? captureMessageBody(new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }), this.bodyCapture)
            : null;
          this.track(this.finishRecord({
            ctx, spanId: ctx.spanId, parentSpanId: validParent?.spanId ?? null, kind: 'server', method, url, startedAt,
            statusCode, requestHeaders: incoming ? new Headers(incoming) : new Headers(), responseHeaders: null,
            error, requestCapture: null, responseCapture, mockedBy: null, skipped: [],
          }));
        }
      }
    });
  }

  /**
   * Wraps every HTTP export of a route module at once.
   *
   * Hand-wrapping dozens of routes is where instrumentation coverage silently
   * goes missing, so this keeps a route file to a single line.
   */
  wrapRouteModule<T extends Record<string, unknown>>(handlers: T): T {
    const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const wrapped: Record<string, unknown> = { ...handlers };
    for (const verb of verbs) {
      const handler = handlers[verb];
      if (typeof handler === 'function') {
        wrapped[verb] = this.wrapRoute(handler as (request: Request, context: unknown) => Promise<Response>);
      }
    }
    return wrapped as T;
  }

  private originAllowed(url: string): boolean {
    if (this.allowAnyOrigin) return true;
    try {
      const origin = new URL(url).origin;
      return this.allowed.has(origin) || this.learnedOrigins.has(origin);
    } catch {
      return false;
    }
  }

  private async decide(
    kind: 'client' | 'server',
    method: string,
    url: string,
    headers: Headers,
    ctx: Context,
    requestCapture: Promise<CaptureOutcome> | null,
  ): Promise<{ rule: ServerMockRule | null; skipped: MockSkipReason[] }> {
    const active = this.rules.filter((rule) => rule.enabled);
    if (active.length === 0) return { rule: null, skipped: [] };

    // The body is only materialised when a rule actually needs it.
    const needsBody = active.some((rule) => Boolean(rule.match.bodyContains));
    const bodyText = needsBody ? (await settleCapture(requestCapture, 1_000)).body?.content ?? null : null;
    return this.pick(kind, method, url, headers, ctx, bodyText);
  }

  /** Synchronous rule selection, for clients that must choose real or mocked when the request is created. */
  private pick(
    kind: 'client' | 'server',
    method: string,
    url: string,
    headers: Headers,
    ctx: Context,
    bodyText: string | null,
  ): { rule: ServerMockRule | null; skipped: MockSkipReason[] } {
    if (!this.rules.some((rule) => rule.enabled)) return { rule: null, skipped: [] };
    const decision = selectMockRule(this.rules, { kind, method, url, headers, bodyText, sessionId: ctx.sessionId });
    if (decision.rule) {
      decision.rule.appliedCount += 1;
      // The rules live in the process the extension talks to; its budget must count this use too.
      if (ctx.relayTo) this.track(this.relayPost(ctx.relayTo, 'consume', { ruleIds: [decision.rule.id] }));
    }
    return decision;
  }

  private async serveMock(
    rule: ServerMockRule,
    skipped: MockSkipReason[],
    ctx: Context,
    spanId: string,
    method: string,
    url: string,
    headers: Headers,
    startedAt: number,
    requestCapture: Promise<CaptureOutcome> | null,
    signal: AbortSignal | null,
    fallback: () => Promise<Response>,
  ): Promise<Response> {
    const parentSpanId = ctx.spanId === spanId ? null : ctx.spanId;
    const kind: 'server' | 'client' = ctx.spanId === spanId ? 'server' : 'client';
    let response: Response;
    let mockedBy: string | null = rule.name;

    try {
      response = await buildMockResponse(rule, signal);
    } catch (cause) {
      const intentional = cause instanceof MockNetworkError || (cause instanceof Error && cause.name === 'AbortError');
      if (intentional) {
        this.track(this.finishRecord({
          ctx, spanId, parentSpanId, kind, method, url, startedAt,
          statusCode: null, requestHeaders: headers, responseHeaders: null,
          error: cause instanceof MockNetworkError ? `Simulated by "${cause.ruleName}"` : 'AbortError',
          requestCapture, responseCapture: null, mockedBy: rule.name, skipped,
        }));
        throw cause;
      }
      // A malformed rule must degrade to the real behaviour, never break the app.
      mockedBy = null;
      try {
        response = await fallback();
      } catch (fallbackCause) {
        this.track(this.finishRecord({
          ctx, spanId, parentSpanId, kind, method, url, startedAt,
          statusCode: null, requestHeaders: headers, responseHeaders: null,
          error: fallbackCause instanceof Error ? fallbackCause.name : 'FetchError',
          requestCapture, responseCapture: null, mockedBy: null, skipped,
        }));
        throw fallbackCause;
      }
    }

    const responseCapture = this.bodyCapture.response ? captureMessageBody(response, this.bodyCapture) : null;
    this.track(this.finishRecord({
      ctx, spanId, parentSpanId, kind, method, url, startedAt,
      statusCode: response.status, requestHeaders: headers, responseHeaders: response.headers,
      error: null, requestCapture, responseCapture, mockedBy, skipped,
    }));
    return response;
  }

  /**
   * Rewrites a real upstream response for a `passthrough-mutate` rule.
   *
   * Reads the real body, applies the mutations and hands back a fresh
   * Response; on any failure the untouched original is returned so a broken
   * rule can never break the application.
   */
  private async mutatePassthrough(
    rule: ServerMockRule,
    skipped: MockSkipReason[],
    response: Response,
    ctx: Context,
    spanId: string,
    method: string,
    url: string,
    headers: Headers,
    startedAt: number,
    requestCapture: Promise<CaptureOutcome> | null,
  ): Promise<Response> {
    let mutated = response;
    let mockedBy: string | null = null;
    try {
      const original = await response.clone().text();
      const next = applyFieldMutations(original, rule.action.fieldMutations ?? []);
      if (next !== original) {
        const nextHeaders = new Headers(response.headers);
        nextHeaders.delete('content-length');
        nextHeaders.delete('content-encoding');
        nextHeaders.set('x-apilens-mock', headerSafe(rule.name));
        for (const [name, value] of Object.entries(rule.action.headers ?? {})) {
          try {
            nextHeaders.set(name, headerSafe(String(value)));
          } catch {
            // Skip a header the platform rejects rather than failing the call.
          }
        }
        mutated = new Response(next, {
          status: rule.action.statusCode ?? response.status,
          statusText: rule.action.statusText ? headerSafe(rule.action.statusText) : response.statusText,
          headers: nextHeaders,
        });
        mockedBy = rule.name;
      }
    } catch {
      mutated = response;
    }

    const responseCapture = this.bodyCapture.response ? captureMessageBody(mutated, this.bodyCapture) : null;
    this.track(this.finishRecord({
      ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
      statusCode: mutated.status, requestHeaders: headers, responseHeaders: mutated.headers,
      error: null, requestCapture, responseCapture, mockedBy, skipped,
    }));
    return mutated;
  }

  private track(promise: Promise<void>): void {
    this.pendingRecords.add(promise);
    void promise.finally(() => this.pendingRecords.delete(promise));
  }

  private async finishRecord(input: {
    ctx: Context; spanId: string; parentSpanId: string | null; kind: 'server' | 'client';
    method: string; url: string; startedAt: number; statusCode: number | null;
    requestHeaders: Headers; responseHeaders: Headers | null; error: string | null;
    requestCapture: Promise<CaptureOutcome> | null; responseCapture: Promise<CaptureOutcome> | null;
    mockedBy: string | null; skipped: MockSkipReason[]; cache?: 'hit';
  }): Promise<void> {
    if (!this.enabled) return;
    adoptMiddlewareLink(input.ctx);
    if (input.kind === 'client' && !input.cache) this.stats.backendCalls += 1;
    const endedAt = Date.now();
    const [request, response] = await Promise.all([
      settleCapture(input.requestCapture, 5_000),
      settleCapture(input.responseCapture, 5_000),
    ]);
    const bodySettledAt = Date.now();

    const parts = safeUrlParts(input.url);
    const requestHeaders = redactHeaders(input.requestHeaders);
    const responseHeaders = redactHeaders(input.responseHeaders);
    const status: 'ok' | 'error' = input.error || (input.statusCode ?? 0) >= 400 ? 'error' : 'ok';

    const call: Omit<ServerCall, 'seq'> = {
      spanId: input.spanId,
      traceId: input.ctx.traceId,
      parentSpanId: input.parentSpanId,
      sessionId: input.ctx.sessionId,
      scenarioId: input.ctx.scenarioId ?? null,
      serviceName: this.options.serviceName,
      kind: input.kind,
      method: input.method,
      url: parts.url,
      origin: parts.origin,
      path: parts.path,
      query: parts.query,
      statusCode: input.statusCode,
      status,
      startedAt: input.startedAt,
      endedAt,
      durationMs: endedAt - input.startedAt,
      bodyDurationMs: response.body ? bodySettledAt - input.startedAt : null,
      requestHeaders,
      responseHeaders,
      requestBody: request.body,
      responseBody: response.body,
      requestBodyOmitted: request.omitted,
      responseBodyOmitted: response.omitted,
      error: input.error,
      mockedBy: input.mockedBy,
      ...(input.cache ? { cache: input.cache } : {}),
      ...(input.kind === 'server' && input.ctx.middlewareSpanId ? { middlewareSpanId: input.ctx.middlewareSpanId } : {}),
    };
    if (input.ctx.relayTo) await this.relayPost(input.ctx.relayTo, 'ingest', { calls: [call] });
    else this.buffer.add(call);

    this.reporter.add({
      traceId: call.traceId, spanId: call.spanId, parentSpanId: call.parentSpanId, sessionId: call.sessionId,
      serviceName: call.serviceName, operationName: `${call.method} ${call.url}`, kind: call.kind,
      source: 'internal-service', channel: 'server-sdk', method: call.method, url: call.url,
      statusCode: call.statusCode, status, startedAt: call.startedAt, endedAt: call.endedAt,
      durationMs: call.durationMs,
      attributes: {
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify(responseHeaders),
        scenario: input.ctx.scenarioId ?? '',
        timingScope: response.body ? 'response-body' : 'response-headers',
        bodyCapture: Boolean(request.body || response.body),
        requestBody: serialiseBody(request.body),
        responseBody: serialiseBody(response.body),
        requestBodyOmitted: request.omitted ?? '',
        responseBodyOmitted: response.omitted ?? '',
        mockSkipped: input.skipped.length ? JSON.stringify(input.skipped.slice(0, 10)) : '',
      },
      events: [],
      error: input.error,
      mockedBy: input.mockedBy,
    });
  }

  /**
   * Where this process should forward captures, or null to keep them.
   *
   * Only processes that have not answered the extension relay: on Vercel the
   * API function hosting the control route becomes the store, and page
   * functions forward to it.
   */
  private relayTarget(requestUrl: string): string | null {
    const relay = this.controlOptions?.relay;
    if (!relay || this.servedControl) return null;
    if (relay.url) return relay.url.replace(/\/$/, '');
    try {
      return `${new URL(requestUrl).origin}/api/__apilens`;
    } catch {
      return null;
    }
  }

  private async relayRequest(base: string, operation: string, init: RequestInit): Promise<Response | null> {
    const relay = this.controlOptions?.relay;
    try {
      // insideFetch keeps the SDK's own traffic out of the capture.
      const response = await this.insideFetch.run(true, () => fetch(`${base}/${operation}`, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(relay?.timeoutMs ?? 3_000),
        headers: {
          ...(relay?.headers ?? {}),
          authorization: `Bearer ${this.controlOptions?.token ?? ''}`,
          'content-type': 'application/json',
        },
      }));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (cause) {
      this.relayFailures += 1;
      this.lastRelayError = `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`;
      return null;
    }
  }

  private async relayPost(base: string, operation: 'ingest' | 'consume', payload: unknown): Promise<void> {
    await this.relayRequest(base, operation, { method: 'POST', body: JSON.stringify(payload) });
  }

  /** Refreshes the mock rules from the relay target; keeps the last copy if it cannot. */
  private async pullRules(base: string): Promise<void> {
    const response = await this.relayRequest(base, 'rules', { method: 'GET' });
    const payload = response ? (await response.json().catch(() => null)) as { rules?: unknown } | null : null;
    if (Array.isArray(payload?.rules)) this.setServerMockRules(payload.rules);
  }

  private ingestRelayed(calls: unknown[]): number {
    let kept = 0;
    for (const raw of calls) {
      const call = relayedCall(raw);
      if (call) {
        this.buffer.add(call);
        kept += 1;
        if (call.stage === 'middleware' && call.kind === 'server') this.stats.middlewareRuns += 1;
      }
    }
    return kept;
  }

  /** Drains pending captures, then delivers queued spans to the agent. */
  async flush(): Promise<void> {
    while (this.pendingRecords.size > 0) await Promise.allSettled([...this.pendingRecords]);
    await this.reporter.flush();
  }

  async shutdown(): Promise<void> {
    await this.flush();
    this.stopped = true;
    if (this.requestHook) clearRequestHook(this.requestHook);
    this.requestHook = null;
    if (this.outgoingHook) clearOutgoingHook(this.outgoingHook);
    this.outgoingHook = null;
    if (this.cacheLayer && globalThis.fetch === this.cacheLayer.outer) {
      // Back to a plain property. Whatever Next installed stays, still calling down through the (now inert) layers.
      const inner = this.cacheLayer.inner();
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true, enumerable: true, writable: true,
        value: inner === this.wrapper && this.downstream ? this.downstream : inner,
      });
    } else if (globalThis.fetch === this.wrapper && this.downstream) {
      globalThis.fetch = this.downstream;
    }
    this.cacheLayer = null;
    await this.reporter.shutdown();
  }
}

/** Validates a call relayed by another process; anything malformed is dropped. */
function relayedCall(raw: unknown): Omit<ServerCall, 'seq'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string, max = 4_096) => (typeof value[key] === 'string' ? (value[key] as string).slice(0, max) : null);
  const num = (key: string) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? (value[key] as number) : null);
  const record = (key: string): Record<string, string> => {
    const entry = value[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>).filter(([, item]) => typeof item === 'string').slice(0, 200),
    ) as Record<string, string>;
  };
  const body = (key: string): CapturedBody | null => {
    const entry = value[key] as CapturedBody | null | undefined;
    return entry && typeof entry === 'object' && typeof entry.content === 'string' ? entry : null;
  };
  const kind = value.kind === 'server' || value.kind === 'client' ? value.kind : null;
  const spanId = text('spanId', 64);
  const traceId = text('traceId', 64);
  const startedAt = num('startedAt');
  const endedAt = num('endedAt');
  if (!kind || !spanId || !traceId || startedAt === null || endedAt === null) return null;
  return {
    spanId, traceId, kind, startedAt, endedAt,
    parentSpanId: text('parentSpanId', 64),
    sessionId: text('sessionId', 128) ?? AMBIENT_SESSION_ID,
    scenarioId: text('scenarioId', 128),
    serviceName: text('serviceName', 200) ?? 'unknown',
    method: (text('method', 16) ?? 'GET').toUpperCase(),
    url: text('url') ?? '',
    origin: text('origin') ?? '',
    path: text('path') ?? '',
    query: record('query'),
    statusCode: num('statusCode'),
    status: value.status === 'error' ? 'error' : 'ok',
    durationMs: num('durationMs') ?? endedAt - startedAt,
    bodyDurationMs: num('bodyDurationMs'),
    requestHeaders: record('requestHeaders'),
    responseHeaders: record('responseHeaders'),
    requestBody: body('requestBody'),
    responseBody: body('responseBody'),
    requestBodyOmitted: text('requestBodyOmitted', 500),
    responseBodyOmitted: text('responseBodyOmitted', 500),
    error: text('error', 500),
    mockedBy: text('mockedBy', 500),
    ...(value.stage === 'middleware' ? { stage: 'middleware' as const } : {}),
    ...(text('middlewareSpanId', 64) ? { middlewareSpanId: text('middlewareSpanId', 64) } : {}),
    ...(value.cache === 'hit' ? { cache: 'hit' as const } : {}),
  };
}

/** Absolute URL for a rendered page, from the forwarded host when there is one. */
function renderUrl(path: string, headers: Headers | null): string {
  const pathPart = path.startsWith('/') ? path : `/${path}`;
  const forwarded = headers?.get('x-forwarded-host')?.split(',')[0]?.trim();
  const candidate = forwarded || headers?.get('host') || 'localhost';
  const host = /^[a-zA-Z0-9.\-[\]:]{1,255}$/.test(candidate) ? candidate : 'localhost';
  const proto = headers?.get('x-forwarded-proto')?.split(',')[0]?.trim()
    ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
  try {
    return new URL(pathPart, `${proto === 'http' ? 'http' : 'https'}://${host}`).toString();
  } catch {
    return `http://localhost${pathPart}`;
  }
}

/** The URL a fetch call targets, for ignore matching only. */
function fetchUrl(input: RequestInfo | URL): string {
  try {
    return input instanceof Request ? input.url : String(input);
  } catch {
    return '';
  }
}

/** A short, non-sensitive label for a failure: the system error code when there is one. */
function errorName(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return cause instanceof Error ? cause.name : 'RequestError';
}

/** Data a page loaded (JSON-safe), as opposed to rendered React output. */
function isPlainData(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== 'object' || '$$typeof' in value) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialiseBody(body: CapturedBody | null): string {
  return body ? JSON.stringify(body) : '';
}
