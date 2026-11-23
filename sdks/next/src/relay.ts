import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import { captureBytes, resolveBodyCapture, type BodyCaptureConfig, type CaptureOutcome } from './bodies';
import { decodeBody } from './incoming';
import { applyFieldMutations, buildMockResponse, MockNetworkError, sanitizeRule, selectMockRule } from './mocks';
import { redactHeaders, safeUrlParts } from './redaction';
import { traceKey, type TraceOwner } from './trace-registry';
import type { BodyCaptureOptions, RelayStatus, ServerCall, ServerMockRule } from './types';
import { SDK_VERSION } from './version';

/**
 * The ApiLens relay: a small forwarding proxy for a backend you cannot (or
 * would rather not) instrument, such as a Spring service calling TMF APIs.
 *
 * The backend's upstream base URLs are pointed at the relay
 * (`http://apilens-relay/tmf622` instead of `https://tmf622.internal`), and
 * the relay forwards every request unchanged. Requests that carry a QA
 * session (`x-qa-session-id`, propagated from the BFF) are also recorded and
 * delivered to the app's control plane, where the extension shows them under
 * the page that caused them, and can be answered by a server mock instead.
 *
 * A backend that drops the session header but continues the tester's trace
 * (Datadog, OpenTelemetry, Brave…) is handled too: while a tester is active
 * the relay asks the app which session a trace belongs to.
 *
 * On a shared environment (the default) a request that belongs to no QA
 * session is piped straight through: never buffered, recorded or mocked.
 * Other squads' traffic sees a plain proxy.
 */

export interface RelayRoute {
  /** First path segment the backend calls, such as `tmf622`. Shown in the extension. */
  name: string;
  /** Where that traffic really goes: origin plus optional base path. */
  target: string;
  /**
   * Who calls this route, when not `callerName`: `tmf` for an OSB route the
   * TMF services use. The extension nests a call under the hop whose route
   * starts with this name, so OSB calls appear under the TMF call that made them.
   */
  caller?: string;
}

export interface RelayOptions {
  /** `[{ name: 'tmf622', target: 'https://tmf622.dev.internal' }]` or `{ tmf622: 'https://…' }`. */
  routes: RelayRoute[] | Record<string, string>;
  /** The app's control plane, the same one the extension connects to. */
  control: {
    /** For example `https://clear-dev.example.com/api/__apilens`. */
    url: string;
    token: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
  };
  /** Identifies this relay in the extension. Default `apilens-relay`. */
  name?: string;
  /** The service whose calls pass through, recorded as the caller. Default `backend`. */
  callerName?: string;
  /**
   * Default true: traffic without a QA session is forwarded untouched and never
   * recorded or mocked. False records it under the ambient session and lets
   * rules without a session apply to it; only for an environment you own.
   */
  sharedEnvironment?: boolean;
  captureBodies?: BodyCaptureOptions;
  /** Largest request body buffered for a recorded call. Default 8 MB. */
  maxRequestBytes?: number;
  /** How often mock rules are refreshed from the control plane. Default 2 s. */
  rulesIntervalMs?: number;
  /** How often recorded calls are delivered. Default 250 ms. */
  flushIntervalMs?: number;
  /** Status sent when there is nothing to deliver, so the extension knows the relay is alive. Default 15 s. */
  heartbeatMs?: number;
  /** Calls held while the control plane is unreachable before the oldest are dropped. Default 1000. */
  maxQueue?: number;
  /**
   * Longest wait for the app to say whose trace a request belongs to, when the
   * backend dropped the session header. On timeout the request is passed
   * through as another squad's. Default 300 ms.
   */
  attributionTimeoutMs?: number;
  log?: (line: string) => void;
}

const SESSION_HEADER = 'x-qa-session-id';
const SCENARIO_HEADER = 'x-test-scenario-id';
const AMBIENT_SESSION_ID = 'apilens-ambient';
const RELAY_PATH = '/__relay';
const MAX_BATCH = 50;
const HARD_REQUEST_CAP = 32 * 1024 * 1024;
/** Trace lookups only happen this long after the relay last heard of a tester; otherwise there is no one to find. */
const TESTER_ACTIVE_MS = 15 * 60_000;
/** A trace the app does not know is not asked about again for this long (learned traces still win). */
const UNKNOWN_TRACE_MS = 30_000;
const KNOWN_TRACE_MS = 10 * 60_000;
const MAX_TRACE_CACHE = 10_000;
/** Lookups per second, at most; beyond it a request is treated as another squad's. */
const LOOKUPS_PER_SECOND = 20;

/** Never forwarded: they describe one connection, not the request (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const safeId = (value: string | null | undefined): string | undefined =>
  value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** `x-qa-session-id` as a header, or as a W3C baggage entry (OpenTelemetry propagates baggage by default). */
export function sessionFromHeaders(req: IncomingMessage): string | undefined {
  const direct = safeId(header(req, SESSION_HEADER));
  if (direct) return direct;
  for (const entry of (header(req, 'baggage') ?? '').split(',')) {
    const [key, value] = entry.split(';')[0]!.split('=');
    if (key?.trim().toLowerCase() === SESSION_HEADER && value) {
      try {
        return safeId(decodeURIComponent(value.trim()));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function parseTraceparent(value: string | undefined): { traceId: string; spanId: string } | null {
  const match = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec((value ?? '').trim().toLowerCase());
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return null;
  return { traceId: match[1]!, spanId: match[2]! };
}

/** B3, which many Spring (Brave/Zipkin) services send instead of traceparent. 64-bit ids are widened to 128. */
function parseB3(single: string | undefined, traceId: string | undefined, spanId: string | undefined): { traceId: string; spanId: string } | null {
  const [trace, span] = single ? single.trim().toLowerCase().split('-') : [traceId?.trim().toLowerCase(), spanId?.trim().toLowerCase()];
  if (!trace || !span || !/^([\da-f]{16}|[\da-f]{32})$/.test(trace) || !/^[\da-f]{16}$/.test(span) || /^0+$/.test(trace)) return null;
  return { traceId: trace.padStart(32, '0'), spanId: span };
}

const decimalToHex = (value: string | undefined): string | null => {
  const digits = (value ?? '').trim();
  if (!/^\d{1,20}$/.test(digits)) return null;
  const number = BigInt(digits);
  return number > 0n && number < 1n << 64n ? number.toString(16).padStart(16, '0') : null;
};

/**
 * Datadog's own headers, which its tracers send when not configured for W3C:
 * decimal 64-bit ids, with the trace's upper 64 bits in `_dd.p.tid` when the
 * tracer generates 128-bit traces.
 */
function parseDatadog(traceId: string | undefined, parentId: string | undefined, tags: string | undefined): { traceId: string; spanId: string } | null {
  const low = decimalToHex(traceId);
  const span = decimalToHex(parentId);
  if (!low || !span) return null;
  const high = /(?:^|,)\s*_dd\.p\.tid=([\da-f]{16})(?:,|$)/i.exec(tags ?? '')?.[1]?.toLowerCase() ?? '0'.repeat(16);
  return { traceId: `${high}${low}`, spanId: span };
}

/** The caller's trace: W3C first, then B3, then Datadog. */
export function traceFromHeaders(req: IncomingMessage): { traceId: string; spanId: string } | null {
  return parseTraceparent(header(req, 'traceparent'))
    ?? parseB3(header(req, 'b3'), header(req, 'x-b3-traceid'), header(req, 'x-b3-spanid'))
    ?? parseDatadog(header(req, 'x-datadog-trace-id'), header(req, 'x-datadog-parent-id'), header(req, 'x-datadog-tags'));
}

/** Whose request this is, and how the relay knows. */
interface Identity {
  sessionId: string;
  scenarioId: string | null;
  trace: { traceId: string; spanId: string } | null;
  attributed: boolean;
  byTrace: boolean;
}

interface ResolvedRoute {
  base: URL;
  caller: string | null;
}

export function normaliseRoutes(routes: RelayOptions['routes']): Map<string, ResolvedRoute> {
  const list: RelayRoute[] = Array.isArray(routes) ? routes : Object.entries(routes).map(([name, target]) => ({ name, target }));
  const result = new Map<string, ResolvedRoute>();
  for (const { name, target, caller } of list) {
    if (!/^[a-z0-9][\w-]{0,63}$/i.test(name)) throw new Error(`Relay route name "${name}" must be letters, digits, - or _.`);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error(`Relay route "${name}" has a target that is not a URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Relay route "${name}" must target http or https.`);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    result.set(name.toLowerCase(), { base: url, caller: caller?.trim().slice(0, 200) || null });
  }
  if (result.size === 0) throw new Error('The relay needs at least one route.');
  return result;
}

/** Applies `osb=tmf,vesta=tmf` (APILENS_RELAY_CALLERS) to parsed routes. */
export function withCallers(routes: Record<string, string>, callers: string | undefined): RelayRoute[] {
  const byRoute = parseRoutesEnv(callers);
  for (const name of Object.keys(byRoute)) {
    if (!(name in routes)) throw new Error(`APILENS_RELAY_CALLERS names "${name}", which is not in APILENS_RELAY_ROUTES.`);
  }
  return Object.entries(routes).map(([name, target]) => ({ name, target, ...(byRoute[name] ? { caller: byRoute[name] } : {}) }));
}

/** Parses `tmf622=https://a,tmf629=https://b` (commas or newlines). */
export function parseRoutesEnv(value: string | undefined): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const entry of (value ?? '').split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) throw new Error(`APILENS_RELAY_ROUTES entry "${trimmed}" is not name=url.`);
    routes[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return routes;
}

/** Headers to send upstream: everything the backend sent, minus connection-level ones. */
function forwardHeaders(req: IncomingMessage, target: URL, bodyLength: number | null): OutgoingHttpHeaders {
  const listed = new Set((header(req, 'connection') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || name === 'host') continue;
    result[name] = value;
  }
  result.host = target.host;
  if (bodyLength !== null) {
    delete result['content-length'];
    if (bodyLength > 0 || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method ?? 'GET')) result['content-length'] = String(bodyLength);
  }
  return result;
}

/** The upstream response headers as a flat [name, value, …] list, keeping repeated headers such as set-cookie. */
function responseHeaderList(raw: string[], drop: Set<string> = new Set()): string[] {
  const result: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || drop.has(name)) continue;
    result.push(raw[index]!, raw[index + 1]!);
  }
  return result;
}

function headersFromRaw(raw: string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    try {
      headers.append(raw[index]!, raw[index + 1]!);
    } catch {
      // A header the platform rejects is simply not recorded.
    }
  }
  return headers;
}

function nodeRequestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, item);
      } catch {
        // Skipped, as above.
      }
    }
  }
  return headers;
}

function readAll(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > cap) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function captureBuffer(bytes: Buffer, contentType: string | null, contentEncoding: string | null, config: BodyCaptureConfig): Promise<CaptureOutcome> {
  if (bytes.byteLength === 0) return { body: null, omitted: null };
  const decoded = await decodeBody(bytes, contentEncoding, config.maxBytes);
  if (!decoded) return { body: null, omitted: `Not captured: ${contentEncoding} body could not be decoded` };
  return captureBytes(decoded.subarray(0, config.maxBytes), decoded.byteLength > config.maxBytes, contentType, config);
}

interface Pending {
  /** Called once the call is recorded. */
  settle: () => void;
  recorded: boolean;
  route: string;
  caller: string;
  method: string;
  targetUrl: string;
  sessionId: string;
  scenarioId: string | null;
  trace: { traceId: string; spanId: string } | null;
  startedAt: number;
  requestHeaders: Headers;
  request: CaptureOutcome;
}

export class ApiLensRelay {
  private readonly routes: Map<string, ResolvedRoute>;
  private readonly controlUrl: string;
  private readonly bodyConfig: BodyCaptureConfig;
  private readonly shared: boolean;
  private readonly name: string;
  private readonly caller: string;
  private readonly maxRequestBytes: number;
  private readonly maxQueue: number;
  private readonly log: (line: string) => void;
  private readonly agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  private rules: ServerMockRule[] = [];
  private queue: Array<Omit<ServerCall, 'seq'>> = [];
  private flushing = false;
  private lastDelivery = 0;
  private timers: NodeJS.Timeout[] = [];
  private server: http.Server | null = null;
  private lastControlError: string | null = null;
  private readonly failing = new Map<string, string>();
  /** Calls whose response is still on its way, so flush() can wait for them. */
  private readonly open = new Set<Promise<void>>();
  private readonly stats = { forwarded: 0, captured: 0, unattributed: 0, traced: 0, tracedAmbient: 0, mocked: 0, upstreamErrors: 0, dropped: 0 };
  /** Trace key → its tester (or null: not a tester's), with when that answer expires. */
  private readonly owners = new Map<string, { owner: TraceOwner | null; until: number }>();
  private readonly lookups = new Map<string, Promise<TraceOwner | null>>();
  private lookupWindow = { second: 0, count: 0 };
  private testerSeenAt = 0;

  constructor(private readonly options: RelayOptions) {
    this.routes = normaliseRoutes(options.routes);
    if (!/^https?:\/\//.test(options.control?.url ?? '')) throw new Error('control.url must be the app control plane, such as https://app.example/api/__apilens.');
    if (!options.control.token || options.control.token.length < 24) throw new Error('control.token must be the app control token (24+ characters).');
    this.controlUrl = options.control.url.replace(/\/+$/, '');
    this.bodyConfig = resolveBodyCapture(options.captureBodies);
    this.shared = options.sharedEnvironment !== false;
    this.name = safeId(options.name) ?? 'apilens-relay';
    this.caller = (options.callerName ?? 'backend').slice(0, 200);
    this.maxRequestBytes = Math.min(options.maxRequestBytes ?? 8 * 1024 * 1024, HARD_REQUEST_CAP);
    this.maxQueue = options.maxQueue ?? 1_000;
    this.log = options.log ?? (() => undefined);
  }

  status(): Omit<RelayStatus, 'lastSeenAt'> {
    return { name: this.name, version: SDK_VERSION, routes: [...this.routes.keys()], sharedEnvironment: this.shared, ...this.stats };
  }

  get lastError(): string | null { return this.lastControlError; }

  /** Starts listening and the background rule refresh and delivery. */
  async listen(port: number, host = '0.0.0.0'): Promise<http.Server> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    // Upstreams such as OSB can take a while; the backend's own client timeout decides, not ours.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    this.server = server;
    this.start();
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    return server;
  }

  /** Background work only, for tests or when mounting `handle` on your own server. */
  start(): void {
    if (this.timers.length) return;
    void this.refreshRules();
    const every = (ms: number, task: () => void) => {
      const timer = setInterval(task, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.options.rulesIntervalMs ?? 2_000, () => void this.refreshRules());
    every(this.options.flushIntervalMs ?? 250, () => {
      const idle = Date.now() - this.lastDelivery > (this.options.heartbeatMs ?? 15_000);
      if (this.queue.length || idle) void this.flush();
    });
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.flush();
    this.agents.http.destroy();
    this.agents.https.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawPath = req.url ?? '/';
    if (rawPath === `${RELAY_PATH}/health` || rawPath === `${RELAY_PATH}/ready`) {
      // Probes only: no traffic, no addresses, no counters.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, name: this.name, version: SDK_VERSION, routes: [...this.routes.keys()] }));
      return;
    }

    const match = /^\/([^/?#]+)([^#]*)$/.exec(rawPath);
    const routeName = match?.[1]?.toLowerCase() ?? '';
    const route = this.routes.get(routeName);
    if (!route) {
      res.writeHead(502, { 'content-type': 'application/json', 'x-apilens-relay': 'no-route' });
      res.end(JSON.stringify({ error: `ApiLens relay has no route "${routeName}". Known routes: ${[...this.routes.keys()].join(', ')}.` }));
      return;
    }
    const base = route.base;
    const rest = match![2] ?? '';
    const target = new URL(base.href);
    const queryAt = rest.indexOf('?');
    target.pathname = `${base.pathname.replace(/\/+$/, '')}${queryAt >= 0 ? rest.slice(0, queryAt) : rest}` || '/';
    target.search = queryAt >= 0 ? rest.slice(queryAt) : '';
    this.stats.forwarded += 1;

    const identity = await this.identify(req);
    const attributed = identity.attributed;
    if (!attributed) this.stats.unattributed += 1;
    if (!attributed && this.shared) {
      this.pipe(req, res, target);
      return;
    }

    const declared = Number(header(req, 'content-length') ?? '0');
    if (declared > this.maxRequestBytes) {
      // Too large to hold for matching; forwarded as is and recorded without bodies or mocks.
      this.pipe(req, res, target, this.pending(req, routeName, route.caller, target, identity, { body: null, omitted: `Not captured: larger than ${this.maxRequestBytes} bytes` }));
      return;
    }
    let body: Buffer | null;
    try {
      body = await readAll(req, this.maxRequestBytes);
    } catch {
      return; // The backend went away mid-request.
    }
    if (body === null) {
      res.writeHead(413, { 'content-type': 'application/json', 'x-apilens-relay': 'too-large' });
      res.end(JSON.stringify({ error: `Request body exceeds the relay limit of ${this.maxRequestBytes} bytes (APILENS_RELAY_MAX_REQUEST_BYTES).` }));
      return;
    }

    const requestCapture = this.bodyConfig.request
      ? await captureBuffer(body, header(req, 'content-type') ?? null, header(req, 'content-encoding') ?? null, this.bodyConfig)
      : { body: null, omitted: null };
    const pending = this.pending(req, routeName, route.caller, target, identity, requestCapture);

    let decision: ReturnType<typeof selectMockRule> = { rule: null, skipped: [] };
    try {
      decision = selectMockRule(
        // Never answer another squad's traffic: a rule only applies to a QA session.
        attributed ? this.rules : this.rules.filter((rule) => !rule.match.sessionId),
        {
          kind: 'client', method: pending.method, url: target.toString(), headers: pending.requestHeaders,
          bodyText: requestCapture.body?.encoding === 'utf8' ? requestCapture.body.content : body.byteLength <= 1_048_576 ? body.toString('utf8') : null,
          sessionId: pending.sessionId,
        },
      );
    } catch {
      // A broken rule never breaks the backend's request.
    }

    const rule = decision.rule;
    if (rule && rule.action.type !== 'passthrough-mutate') {
      await this.serveMock(rule, req, res, pending);
      return;
    }
    this.forward(req, res, target, body, pending, rule);
  }

  /**
   * The QA session of a request: its own header (or baggage) first; failing
   * that, the tester whose trace it continues. Never throws or waits longer
   * than `attributionTimeoutMs`.
   */
  async identify(req: IncomingMessage): Promise<Identity> {
    const trace = traceFromHeaders(req);
    const session = sessionFromHeaders(req);
    const scenarioId = safeId(header(req, SCENARIO_HEADER)) ?? null;
    if (session !== undefined && session !== AMBIENT_SESSION_ID) {
      this.testerSeenAt = Date.now();
      return { sessionId: session, scenarioId, trace, attributed: true, byTrace: false };
    }
    // An untagged request the app passed on (session "apilens-ambient") is looked up too: since 0.8.0 the
    // app also remembers those traces, so they are recorded and mocked under the ambient session.
    const owner = trace ? await this.ownerOf(trace.traceId) : null;
    if (owner) {
      this.stats.traced += 1;
      if (owner.sessionId === AMBIENT_SESSION_ID) this.stats.tracedAmbient += 1;
      // The app's full trace id, so the call nests under the page even when only 64 bits came through.
      return { sessionId: owner.sessionId, scenarioId: scenarioId ?? owner.scenarioId, trace: { traceId: owner.traceId, spanId: trace!.spanId }, attributed: true, byTrace: true };
    }
    return { sessionId: AMBIENT_SESSION_ID, scenarioId, trace, attributed: false, byTrace: false };
  }

  private async ownerOf(traceId: string): Promise<TraceOwner | null> {
    const key = traceKey(traceId);
    if (!key) return null;
    const now = Date.now();
    const cached = this.owners.get(key);
    if (cached && cached.until > now) return cached.owner;
    // No tester around: other squads' traffic never waits on a lookup.
    if (now - this.testerSeenAt > TESTER_ACTIVE_MS) return null;
    const inFlight = this.lookups.get(key);
    if (inFlight) return inFlight;
    const second = Math.floor(now / 1000);
    if (this.lookupWindow.second !== second) this.lookupWindow = { second, count: 0 };
    if (++this.lookupWindow.count > LOOKUPS_PER_SECOND) return null;

    const lookup = (async () => {
      const response = await this.control(`attribution?trace=${key}`, { method: 'GET' }, this.options.attributionTimeoutMs ?? 300);
      const payload = response ? ((await response.json().catch(() => null)) as { owner?: unknown } | null) : null;
      const owner = traceOwner(payload?.owner);
      // A failed lookup is not remembered: the next call of that trace asks again.
      if (response) this.remember(key, owner);
      return owner;
    })().finally(() => this.lookups.delete(key));
    this.lookups.set(key, lookup);
    return lookup;
  }

  private remember(key: string, owner: TraceOwner | null): void {
    const current = this.owners.get(key);
    // An answer from another app process that has not seen the trace never hides one that has.
    if (!owner && current?.owner && current.until > Date.now()) return;
    this.owners.delete(key);
    this.owners.set(key, { owner, until: Date.now() + (owner ? KNOWN_TRACE_MS : UNKNOWN_TRACE_MS) });
    if (owner) this.testerSeenAt = Date.now();
    while (this.owners.size > MAX_TRACE_CACHE) this.owners.delete(this.owners.keys().next().value as string);
  }

  private pending(req: IncomingMessage, route: string, caller: string | null, target: URL, identity: Identity, request: CaptureOutcome): Pending {
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    this.open.add(done);
    void done.then(() => this.open.delete(done));
    return {
      settle,
      recorded: false,
      route,
      caller: caller ?? this.caller,
      method: (req.method ?? 'GET').toUpperCase(),
      targetUrl: target.toString(),
      sessionId: identity.sessionId,
      scenarioId: identity.scenarioId,
      trace: identity.trace,
      startedAt: Date.now(),
      requestHeaders: nodeRequestHeaders(req),
      request,
    };
  }

  private transport(target: URL) {
    return target.protocol === 'https:' ? { request: https.request, agent: this.agents.https } : { request: http.request, agent: this.agents.http };
  }

  private upstreamFailed(res: ServerResponse, target: URL, error: Error): void {
    this.stats.upstreamErrors += 1;
    this.log(`upstream ${target.host} failed: ${error.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json', 'x-apilens-relay': 'upstream-unreachable' });
    res.end(JSON.stringify({ error: `ApiLens relay could not reach ${target.host}: ${error.message}` }));
  }

  /** Streams the request and response through untouched; records afterwards when `pending` is given. */
  private pipe(req: IncomingMessage, res: ServerResponse, target: URL, pending?: Pending): void {
    const { request, agent } = this.transport(target);
    const upstream = request(target, { method: req.method, headers: forwardHeaders(req, target, null), agent }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, responseHeaderList(answer.rawHeaders));
      answer.pipe(res);
      if (pending) {
        answer.on('end', () => {
          this.record(pending, {
            statusCode: answer.statusCode ?? null, responseHeaders: headersFromRaw(answer.rawHeaders),
            response: { body: null, omitted: 'Not captured: request was too large to buffer' }, bodyAt: Date.now(), error: null, mockedBy: null,
          });
        });
      }
    });
    upstream.on('error', (error) => {
      this.upstreamFailed(res, target, error);
      if (pending) this.record(pending, { statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null, error: error.message, mockedBy: null });
    });
    res.on('close', () => {
      if (res.writableFinished) return;
      upstream.destroy();
      if (pending) this.abandoned(pending);
    });
    req.pipe(upstream);
  }

  private forward(req: IncomingMessage, res: ServerResponse, target: URL, body: Buffer, pending: Pending, mutate: ServerMockRule | null): void {
    const { request, agent } = this.transport(target);
    const upstream = request(target, { method: req.method, headers: forwardHeaders(req, target, body.byteLength), agent }, (answer) => {
      const status = answer.statusCode ?? 502;
      const contentType = answer.headers['content-type'] ?? null;
      const contentEncoding = (answer.headers['content-encoding'] as string | undefined) ?? null;
      const finish = (captured: Buffer, truncated: boolean, mockedBy: string | null, encoding: string | null) => {
        const bodyAt = Date.now();
        void (async () => {
          const response = this.bodyConfig.response
            ? await captureBuffer(captured, contentType, encoding, this.bodyConfig).then((outcome) =>
                truncated && outcome.body ? { ...outcome, body: { ...outcome.body, truncated: true } } : outcome)
            : { body: null, omitted: null };
          this.record(pending, { statusCode: status, responseHeaders: headersFromRaw(answer.rawHeaders), response, bodyAt, error: null, mockedBy });
        })();
      };

      if (mutate) {
        // The real answer, changed: needs the whole body, decoded, before anything is sent.
        const chunks: Buffer[] = [];
        answer.on('data', (chunk: Buffer) => chunks.push(chunk));
        answer.on('end', () => {
          void (async () => {
            const raw = Buffer.concat(chunks);
            const decoded = await decodeBody(raw, contentEncoding, HARD_REQUEST_CAP);
            const text = decoded ? applyFieldMutations(decoded.toString('utf8'), mutate.action.fieldMutations ?? []) : null;
            const out = text === null ? raw : Buffer.from(text, 'utf8');
            const drop = new Set(['content-length', ...(text === null ? [] : ['content-encoding', 'etag'])]);
            res.writeHead(status, answer.statusMessage, [...responseHeaderList(answer.rawHeaders, drop), 'content-length', String(out.byteLength), 'x-apilens-mock', mutate.name.replace(/[^\x20-\x7E]/g, '?').slice(0, 128)]);
            res.end(out);
            this.applied(mutate);
            finish(out, false, mutate.name, text === null ? contentEncoding : null);
          })();
        });
        return;
      }

      res.writeHead(status, answer.statusMessage, responseHeaderList(answer.rawHeaders));
      const cap = this.bodyConfig.response ? this.bodyConfig.maxBytes : 0;
      const tapped: Buffer[] = [];
      let size = 0;
      let truncated = false;
      answer.on('data', (chunk: Buffer) => {
        if (size < cap) {
          tapped.push(chunk.subarray(0, cap - size));
          if (chunk.byteLength > cap - size) truncated = true;
          size += Math.min(chunk.byteLength, cap - size);
        } else if (chunk.byteLength) {
          truncated = cap > 0;
        }
      });
      answer.on('end', () => finish(Buffer.concat(tapped), truncated, null, contentEncoding));
      answer.pipe(res);
    });
    upstream.on('error', (error) => {
      this.upstreamFailed(res, target, error);
      this.record(pending, { statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null, error: error.message, mockedBy: null });
    });
    res.on('close', () => {
      if (res.writableFinished) return;
      upstream.destroy();
      this.abandoned(pending);
    });
    upstream.end(body);
  }

  private async serveMock(rule: ServerMockRule, req: IncomingMessage, res: ServerResponse, pending: Pending): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    this.applied(rule);
    try {
      const response = await buildMockResponse(rule, abort.signal);
      const text = await response.text();
      const headers: string[] = [];
      response.headers.forEach((value, name) => headers.push(name, value));
      res.writeHead(response.status, response.statusText || undefined, [...headers, 'content-length', String(Buffer.byteLength(text))]);
      res.end(text);
      const response_ = await captureBuffer(Buffer.from(text, 'utf8'), response.headers.get('content-type'), null, this.bodyConfig);
      this.record(pending, { statusCode: response.status, responseHeaders: response.headers, response: response_, bodyAt: Date.now(), error: null, mockedBy: rule.name });
    } catch (error) {
      if (abort.signal.aborted) {
        this.abandoned(pending, rule.name);
        return;
      }
      // A simulated network failure: the backend sees the connection drop, exactly as if the service were down.
      req.socket.destroy();
      const message = error instanceof MockNetworkError ? error.message : 'Mock failed';
      this.record(pending, { statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null, error: message, mockedBy: rule.name });
    }
  }

  /** The backend hung up (usually its own client timeout) before the answer arrived. */
  private abandoned(pending: Pending, mockedBy: string | null = null): void {
    this.record(pending, {
      statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null,
      error: 'The backend closed the connection before the answer arrived (its own timeout?)', mockedBy,
    });
  }

  private applied(rule: ServerMockRule): void {
    this.stats.mocked += 1;
    rule.appliedCount += 1;
    // Apply budgets ("once") are counted where the rules live.
    void this.control('consume', { method: 'POST', body: JSON.stringify({ ruleIds: [rule.id] }) });
  }

  private record(
    pending: Pending,
    outcome: { statusCode: number | null; responseHeaders: Headers; response: CaptureOutcome; bodyAt: number | null; error: string | null; mockedBy: string | null },
  ): void {
    if (pending.recorded) return;
    pending.recorded = true;
    const endedAt = Date.now();
    const parts = safeUrlParts(pending.targetUrl);
    this.stats.captured += 1;
    pending.settle();
    this.queue.push({
      spanId: hex(8),
      traceId: pending.trace?.traceId ?? hex(16),
      parentSpanId: pending.trace?.spanId ?? null,
      sessionId: pending.sessionId,
      scenarioId: pending.scenarioId,
      serviceName: pending.caller,
      kind: 'client',
      method: pending.method,
      url: parts.url,
      origin: parts.origin,
      path: parts.path,
      query: parts.query,
      statusCode: outcome.statusCode,
      status: outcome.error || (outcome.statusCode ?? 0) >= 400 ? 'error' : 'ok',
      startedAt: pending.startedAt,
      endedAt,
      durationMs: endedAt - pending.startedAt,
      bodyDurationMs: outcome.response.body && outcome.bodyAt ? outcome.bodyAt - pending.startedAt : null,
      requestHeaders: redactHeaders(pending.requestHeaders),
      responseHeaders: redactHeaders(outcome.responseHeaders),
      requestBody: pending.request.body,
      responseBody: outcome.response.body,
      requestBodyOmitted: pending.request.omitted,
      responseBodyOmitted: outcome.response.omitted,
      error: outcome.error,
      mockedBy: outcome.mockedBy,
      layer: pending.route,
    });
    if (this.queue.length > this.maxQueue) {
      const excess = this.queue.length - this.maxQueue;
      this.queue.splice(0, excess);
      this.stats.dropped += excess;
    }
  }

  /** Delivers queued calls, with this relay's status, to the control plane. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    if (this.open.size) {
      // Responses that finish within a moment go out in this delivery; a hung one never holds it up.
      await Promise.race([Promise.all([...this.open]), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
    }
    try {
      do {
        const batch = this.queue.slice(0, MAX_BATCH);
        const delivered = await this.control('ingest', { method: 'POST', body: JSON.stringify({ calls: batch, relay: this.status() }) });
        if (!delivered) break; // Kept for the next tick; maxQueue bounds the wait.
        this.queue.splice(0, batch.length);
        this.lastDelivery = Date.now();
      } while (this.queue.length);
    } finally {
      this.flushing = false;
    }
  }

  async refreshRules(): Promise<void> {
    const response = await this.control('rules', { method: 'GET' });
    const payload = response ? ((await response.json().catch(() => null)) as { rules?: unknown; traces?: unknown; testerActive?: unknown } | null) : null;
    if (payload?.testerActive === true) this.testerSeenAt = Date.now();
    if (Array.isArray(payload?.traces)) {
      // Testers' traces, learned before their calls arrive, so most need no lookup at all.
      for (const raw of payload.traces.slice(0, 500)) {
        const owner = traceOwner(raw);
        // An alias is the trace the backend actually carries (the BFF tracer's), so it is the key.
        const key = owner && traceKey(owner.alias ?? owner.traceId);
        if (key) this.remember(key, owner);
      }
    }
    if (Array.isArray(payload?.rules) && payload.rules.some((rule) => (rule as ServerMockRule | null)?.match?.sessionId)) {
      // A tester's mock is waiting: their calls may come at any moment.
      this.testerSeenAt = Date.now();
    }
    if (!Array.isArray(payload?.rules)) return;
    const now = Date.now();
    const local = new Map(this.rules.map((rule) => [rule.id, rule.appliedCount]));
    this.rules = payload.rules
      .map((rule) => sanitizeRule(rule, now))
      .filter((rule): rule is ServerMockRule => rule !== null)
      // A "once" rule this relay just used stays used until the app's count catches up.
      .map((rule) => ({ ...rule, appliedCount: Math.max(rule.appliedCount, local.get(rule.id) ?? 0) }));
  }

  private async control(operation: string, init: RequestInit, timeoutMs = this.options.control.timeoutMs ?? 5_000): Promise<Response | null> {
    const name = operation.split('?')[0]!;
    try {
      const response = await fetch(`${this.controlUrl}/${operation}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(this.options.control.headers ?? {}), authorization: `Bearer ${this.options.control.token}`, 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 401 ? ' (APILENS_CONTROL_TOKEN does not match the app)' : ''}`);
      if (this.failing.delete(name)) this.log(`control plane ${name}: working again`);
      if (!this.failing.size) this.lastControlError = null;
      return response;
    } catch (cause) {
      const message = `${name}: ${cause instanceof Error ? cause.message : String(cause)}`;
      // Logged when it starts failing or the reason changes, not on every retry.
      if (this.failing.get(name) !== message) this.log(`control plane ${message}`);
      this.failing.set(name, message);
      this.lastControlError = message;
      return null;
    }
  }
}

/** Validates an owner the app sent; anything malformed counts as unknown. */
function traceOwner(raw: unknown): TraceOwner | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const traceId = typeof value.traceId === 'string' && /^[\da-f]{32}$/.test(value.traceId) ? value.traceId : null;
  const sessionId = typeof value.sessionId === 'string' ? safeId(value.sessionId) : undefined;
  // The ambient session is accepted (0.8.0+): the app only shares traces it started itself.
  if (!traceId || !sessionId) return null;
  const scenarioId = typeof value.scenarioId === 'string' ? safeId(value.scenarioId) ?? null : null;
  const alias = typeof value.alias === 'string' && traceKey(value.alias) ? value.alias.toLowerCase() : undefined;
  return { traceId, sessionId, scenarioId, at: typeof value.at === 'number' ? value.at : Date.now(), ...(alias ? { alias } : {}) };
}

export function createRelay(options: RelayOptions): ApiLensRelay {
  return new ApiLensRelay(options);
}
