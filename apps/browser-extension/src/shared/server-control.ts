/**
 * Client for the ApiLens server SDK control plane.
 *
 * The server SDK ships as a standalone tarball and cannot depend on workspace
 * packages, so these types are a structural mirror of
 * `sdks/next/src/types.ts`. Changing one means changing the other.
 *
 * Requests are issued from the service worker, which holds `<all_urls>` host
 * permissions and is therefore not subject to page CORS. That is what lets a
 * tester inspect a remote dev deployment from their own browser.
 */

export const CONTROL_PROTOCOL_VERSION = 2;

export type BodyEncoding = 'utf8' | 'base64';

export interface ServerCapturedBody {
  content: string;
  encoding: BodyEncoding;
  contentType: string | null;
  byteLength: number;
  truncated: boolean;
  redacted: boolean;
}

export interface ServerCall {
  seq: number;
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  sessionId: string;
  scenarioId: string | null;
  serviceName: string;
  kind: 'server' | 'client';
  method: string;
  url: string;
  origin: string;
  path: string;
  query: Record<string, string>;
  statusCode: number | null;
  status: 'ok' | 'error';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  bodyDurationMs: number | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: ServerCapturedBody | null;
  responseBody: ServerCapturedBody | null;
  requestBodyOmitted: string | null;
  responseBodyOmitted: string | null;
  error: string | null;
  mockedBy: string | null;
  /** `middleware` for an Edge middleware run and its calls (SDK 0.5.0+). */
  stage?: 'middleware' | null;
  /** The middleware run that let this page request through (SDK 0.5.0+). */
  middlewareSpanId?: string | null;
  /** `hit` when Next answered from its fetch cache and no backend call was made (SDK 0.5.0+). */
  cache?: 'hit' | null;
  /** Set by the ApiLens relay: the route it went through, such as `tmf622` (SDK 0.6.0+). */
  layer?: string | null;
}

export type ServerMockMatchType = 'glob' | 'regex' | 'contains' | 'equals' | 'startsWith';

export type ServerMockActionType =
  | 'status-code'
  | 'custom-body'
  | 'empty-response'
  | 'invalid-json'
  | 'network-error'
  | 'timeout'
  | 'passthrough-mutate';

export interface ServerFieldMutation {
  path: string;
  operation: 'set' | 'delete' | 'nullify' | 'changeType';
  value?: unknown;
  targetType?: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
}

export interface ServerMockRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  match: {
    method: string;
    urlPattern: string;
    matchType: ServerMockMatchType;
    kind: 'client' | 'server' | 'any';
    bodyContains?: string;
    headerName?: string;
    headerValue?: string;
    sessionId?: string | null;
  };
  action: {
    type: ServerMockActionType;
    statusCode?: number;
    statusText?: string;
    body?: string;
    headers?: Record<string, string>;
    delayMs?: number;
    fieldMutations?: ServerFieldMutation[];
  };
  applyMode: 'always' | 'once' | 'n-times' | 'after-n';
  applyLimit?: number;
  appliedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServerControlHealth {
  ok: true;
  protocolVersion: number;
  sdkVersion: string;
  serviceName: string;
  processId: string;
  startedAt: number;
  enabled: boolean;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  maxBodyBytes: number;
  mockingEnabled: boolean;
  routeMocksEnabled: boolean;
  bufferedCalls: number;
  latestSeq: number;
  droppedCalls: number;
  /** Present from SDK 0.4.0. */
  bufferedBytes?: number;
  maxBufferBytes?: number;
  /** Settings the SDK switched off at boot instead of crashing (SDK 0.4.0+). */
  configIssues?: Array<{ setting: string; problem: string }>;
  ruleCount: number;
  activeRuleCount: number;
  agentDelivery: { accepted: number; dropped: number; lastError: string | null };
  /** What the server's request hook saw and skipped (SDK 0.5.0+). */
  capture?: ServerCaptureStats;
  /** Relays in front of backend services that reported recently (SDK 0.6.0+). */
  relays?: ServerRelayStatus[];
}

/** An ApiLens relay between a backend (such as JCS) and the services it calls. */
export interface ServerRelayStatus {
  name: string;
  version: string;
  routes: string[];
  sharedEnvironment: boolean;
  forwarded: number;
  captured: number;
  unattributed: number;
  /** Recorded calls recognised by their trace id, the backend having dropped the session header (relay 0.7.0+). */
  traced?: number;
  mocked: number;
  upstreamErrors: number;
  dropped: number;
  lastSeenAt: number;
}

export interface ServerCaptureStats {
  installed: boolean;
  installedBy: 'boot' | 'first-connection' | null;
  requestsSeen: number;
  requestsRecorded: number;
  skipped: { ignoredPath: number; noSession: number; originNotAllowed: number; noBackendCall: number };
  lastRejectedOrigin: string | null;
  learnedOrigins: string[];
  backendCalls: number;
  cacheHits: number;
  middlewareRuns: number;
  lastRequestAt: number | null;
}

/** One server process (pod) heard from recently. */
export interface ServerPodStatus {
  processId: string;
  serviceName: string | null;
  lastSeenAt: number;
  bufferedCalls: number | null;
  gap: boolean;
}

/** Everything the UI needs to explain the server link in one glance. */
export interface ServerBridgeStatus {
  configured: boolean;
  connected: boolean;
  /** Endpoint with any credentials stripped; safe to render. */
  endpoint: string | null;
  health: ServerControlHealth | null;
  error: string | null;
  lastSyncAt: number | null;
  /** True when the server buffer rolled over and calls were missed. */
  gap: boolean;
  callCount: number;
  ruleCount: number;
  /** The process that answered most recently. */
  processId: string | null;
  /** Every process heard from recently; more than one means a load balancer spreads the polls. */
  pods?: ServerPodStatus[];
}

export class ServerControlError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'ServerControlError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Normalises whatever the tester pasted into a usable control-plane base URL. */
export function normalizeControlUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  // A bare local address ("localhost:3100") is a dev server without TLS.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed);
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `${local ? 'http' : 'https'}://${trimmed}`;
  const url = new URL(withProtocol);
  url.hash = '';
  url.search = '';
  url.username = '';
  url.password = '';
  // Accept a bare app origin and append the conventional mount path.
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/api/__apilens';
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function describeControlUrl(raw: string): string | null {
  try {
    return normalizeControlUrl(raw) || null;
  } catch {
    return null;
  }
}

async function call<T>(base: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${base}/${path}`, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : 'could not be reached';
    throw new ServerControlError(`ApiLens control endpoint ${reason}. Check the URL, VPN access and that the app is running.`, null);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    throw new ServerControlError('Control token rejected by the server. Paste the exact APILENS_CONTROL_TOKEN value.', 401);
  }
  if (response.status === 404) {
    throw new ServerControlError('No ApiLens control route at that URL. Confirm the catch-all route is deployed and control.enabled is true.', 404);
  }
  if (response.status === 429) {
    throw new ServerControlError('Server is rate limiting ApiLens polling. Increase the poll interval in Settings.', 429);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ServerControlError(`Control endpoint returned HTTP ${response.status}. ${detail.slice(0, 200)}`.trim(), response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new ServerControlError('Control endpoint returned a non-JSON response. A login page or proxy is probably intercepting the request.', response.status);
  }
  return (await response.json()) as T;
}

export interface ServerControlClientOptions {
  url: string;
  token: string;
}

/** Thin, stateless wrapper over the control-plane HTTP surface. */
export class ServerControlClient {
  private readonly base: string;

  constructor(private readonly options: ServerControlClientOptions) {
    this.base = normalizeControlUrl(options.url);
    if (!this.base) throw new ServerControlError('Server control URL is empty.', null);
    if (!options.token) throw new ServerControlError('Server control token is empty.', null);
  }

  get endpoint(): string {
    return this.base;
  }

  health(): Promise<ServerControlHealth> {
    return call<ServerControlHealth>(this.base, this.options.token, 'health');
  }

  /**
   * `cursors` maps each known process to the last seq read from it: behind a
   * load balancer any pod may answer, and each reads its own entry (SDK 0.5+).
   * Older SDKs ignore it and read `since`: the cursor of the pod that answered last.
   */
  calls(since: number, limit = 200, cursors?: Map<string, number>): Promise<{ processId: string; latestSeq: number; calls: ServerCall[]; gap: boolean }> {
    const base = `calls?since=${Math.max(0, Math.trunc(since))}&limit=${limit}`;
    if (!cursors) return call(this.base, this.options.token, base);
    const entries = [...cursors].slice(-64).map(([processId, seq]) => `${encodeURIComponent(processId)}:${Math.max(0, Math.trunc(seq))}`);
    return call(this.base, this.options.token, `${base}&cursors=${entries.join(',')}`);
  }

  clearCalls(): Promise<{ cleared: boolean }> {
    return call(this.base, this.options.token, 'calls', { method: 'DELETE' });
  }

  rules(): Promise<{ processId: string; rules: ServerMockRule[]; revision: string }> {
    return call(this.base, this.options.token, 'rules');
  }

  setRules(rules: ServerMockRule[]): Promise<{ processId: string; rules: ServerMockRule[]; revision: string }> {
    return call(this.base, this.options.token, 'rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
  }
}

/** One row of the route-grouped call list. */
export interface ServerFlowRow {
  call: ServerCall;
  /**
   * 0 for an incoming route or an orphan upstream call. Below it: the
   * middleware run that let the route through (and its calls), the backend
   * calls the route made, and under each of those the calls an ApiLens relay
   * saw that backend make (JCS → TMF → OSB), one level per hop.
   */
  depth: number;
  /** Rows listed under this one: all of them for a route, direct ones below that. */
  childCount: number;
  /** True for the last row among its siblings, so the tree connector can close. */
  last: boolean;
}

/** Deepest level drawn; anything below is shown at this depth. */
export const MAX_FLOW_DEPTH = 4;

/** The session the server SDK records when a request carries none. */
const AMBIENT_SESSION = 'apilens-ambient';

/** Clocks of the app and a relay host differ a little; containment allows this much. */
const RELAY_SKEW_MS = 100;

/** True when `outer` can hold `inner`; two relay calls never hold each other. */
function encloses(outer: ServerCall, inner: ServerCall): boolean {
  if (outer.spanId === inner.spanId || outer.kind !== 'client' || outer.traceId !== inner.traceId) return false;
  // Only the app's clock and a relay's can disagree; two relay hops are timed by relays.
  const skew = outer.layer ? 0 : RELAY_SKEW_MS;
  if (outer.startedAt > inner.startedAt + skew || outer.endedAt < inner.endedAt - skew) return false;
  // An app call never gets a relay parent, so only relay hops need the order that rules out cycles.
  if (!outer.layer) return true;
  return outer.durationMs > inner.durationMs || (outer.durationMs === inner.durationMs && outer.spanId < inner.spanId);
}

/**
 * How likely `outer` made the relay call `inner`, or -1 when it cannot have.
 *
 * Calls from the same caller are siblings (JCS calling TMF622 and TMF629 in
 * parallel), never parent and child, whatever their timing. A relay call
 * whose route names the caller (`tmf622` for a call made by `tmf`) is the
 * best match; then any other relay hop; then the BFF's own call.
 */
function parentRank(outer: ServerCall, inner: ServerCall): number {
  const caller = inner.serviceName.toLowerCase();
  // The BFF's own call to the very service that made this one (`bill-analysis-js` for its TMF678
  // call) beats any other BFF call on the page that happens to run at the same time.
  if (!outer.layer) return serverCallService(outer).toLowerCase() === caller ? 3 : 1;
  if (outer.serviceName.toLowerCase() === caller) return -1;
  return outer.layer.toLowerCase().startsWith(caller) ? 4 : 2;
}

/**
 * The call that made `call`.
 *
 * The SDK links its own calls by span. A relay call carries the backend's
 * span instead (JCS's, which ApiLens never sees), so it goes under the
 * most likely call on the same trace whose time window holds it: the BFF's
 * call to JCS for a TMF call, that TMF call for an OSB call.
 */
export function serverCallParent(call: ServerCall, calls: ServerCall[]): ServerCall | null {
  if (call.kind !== 'client') return null;
  if (call.parentSpanId) {
    const direct = calls.find((candidate) => candidate.spanId === call.parentSpanId && candidate.traceId === call.traceId);
    // A backend that forwards the trace without a span of its own leaves the BFF's span as the parent.
    if (direct && (direct.kind === 'server' || call.layer)) return direct;
  }
  if (!call.layer) return null;
  let best: ServerCall | null = null;
  let bestRank = -1;
  for (const candidate of calls) {
    if (!encloses(candidate, call)) continue;
    const rank = parentRank(candidate, call);
    if (rank < 0) continue;
    const tighter = best !== null && (candidate.startedAt > best.startedAt || (candidate.startedAt === best.startedAt && encloses(best, candidate)));
    if (rank > bestRank || (rank === bestRank && tighter)) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Orders calls so each incoming route is followed by everything it caused.
 *
 * Calls whose route is not in `calls` (filtered out, or evicted from the
 * server buffer) stay top-level rather than disappearing.
 */
export function groupCallsByRoute(calls: ServerCall[]): ServerFlowRow[] {
  const routes = new Map<string, ServerCall>();
  for (const call of calls) if (call.kind === 'server') routes.set(call.spanId, call);

  // A middleware run is shown under the page it let through (SDK 0.5+), not as a page of its own.
  const middlewareOf = new Map<string, ServerCall>();
  const nested = new Set<string>();
  for (const call of calls) {
    const run = call.kind === 'server' && call.middlewareSpanId ? routes.get(call.middlewareSpanId) : undefined;
    if (run && run.stage === 'middleware' && !nested.has(run.spanId)) {
      middlewareOf.set(call.spanId, run);
      nested.add(run.spanId);
    }
  }

  const children = new Map<string, ServerCall[]>();
  const roots: ServerCall[] = [];
  for (const call of calls) {
    if (nested.has(call.spanId)) continue;
    const parent = serverCallParent(call, calls);
    if (parent) {
      const list = children.get(parent.spanId) ?? [];
      list.push(call);
      children.set(parent.spanId, list);
    } else {
      roots.push(call);
    }
  }

  const byStart = (a: ServerCall, b: ServerCall): number => a.startedAt - b.startedAt || a.seq - b.seq;
  const rows: ServerFlowRow[] = [];
  const emit = (call: ServerCall, depth: number, last: boolean, seen: Set<string>): number => {
    const index = rows.length;
    rows.push({ call, depth: Math.min(depth, MAX_FLOW_DEPTH), childCount: 0, last });
    const run = depth === 0 ? middlewareOf.get(call.spanId) : undefined;
    const own = (children.get(call.spanId) ?? []).filter((child) => !seen.has(child.spanId)).sort(byStart);
    const kids: ServerCall[] = run ? [run, ...own] : own;
    let total = 0;
    kids.forEach((child, position) => {
      seen.add(child.spanId);
      total += 1 + emit(child, depth + 1, position === kids.length - 1, seen);
    });
    rows[index]!.childCount = depth === 0 ? total : kids.length;
    return total;
  };
  for (const root of roots.sort(byStart)) emit(root, 0, false, new Set([root.spanId]));
  return rows;
}

/** The call that made `call`, and the calls `call` made, from the captured set. */
export function relatedServerCalls(
  call: ServerCall,
  calls: ServerCall[],
): { parent: ServerCall | null; children: ServerCall[]; middleware: ServerCall | null } {
  const parent = call.kind === 'client'
    ? serverCallParent(call, calls)
    : call.stage === 'middleware'
      ? calls.find((candidate) => candidate.kind === 'server' && candidate.middlewareSpanId === call.spanId) ?? null
      : null;
  const children = calls
    .filter((candidate) => candidate.kind === 'client' && candidate.spanId !== call.spanId && serverCallParent(candidate, calls)?.spanId === call.spanId)
    .sort((a, b) => a.startedAt - b.startedAt);
  const middleware = call.kind === 'server' && call.middlewareSpanId
    ? calls.find((candidate) => candidate.spanId === call.middlewareSpanId && candidate.stage === 'middleware') ?? null
    : null;
  return { parent, children, middleware };
}

/** Builds a server mock rule pre-filled from a captured call. */
export function serverRuleFromCall(call: ServerCall, overrides: Partial<ServerMockRule> = {}): ServerMockRule {
  const now = Date.now();
  return {
    id: `srv-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${call.layer ? `${call.layer.toUpperCase()} ` : ''}${call.method} ${call.path} → 503`,
    description: `Created from a captured ${call.kind === 'client' ? 'outbound' : 'incoming'} call on ${call.serviceName}${call.layer ? ` through the relay route ${call.layer}` : ''}.`,
    enabled: false,
    priority: 100,
    match: {
      method: call.method,
      // Exact path, wildcard origin: survives an environment change without
      // silently widening to every endpoint.
      urlPattern: `*${call.path}`,
      matchType: 'glob',
      kind: call.kind,
      // A relay sits on a shared backend: a mock made from a tester's call answers only that tester.
      ...(call.layer && call.sessionId !== AMBIENT_SESSION ? { sessionId: call.sessionId } : {}),
    },
    action: { type: 'status-code', statusCode: 503, body: JSON.stringify({ error: 'Service unavailable', simulated: true }, null, 2) },
    // One call by default: the server is usually shared with other testers.
    applyMode: 'once',
    appliedCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const SERVER_MOCK_PRESETS: Array<{
  id: string;
  label: string;
  hint: string;
  /** Plain-language scenario name for testers without an HTTP background. */
  title: string;
  /** What the backend will appear to do. */
  effect: string;
  /** What the tester should check on the page afterwards. */
  expect: string;
  apply: (rule: ServerMockRule) => ServerMockRule;
}> = [
  {
    id: 'unavailable',
    title: 'Service is down',
    effect: 'The backend answers “503 Service unavailable”.',
    expect: 'The page shows a friendly error or retry option — not a blank screen or a crash.',
    label: 'Upstream 503',
    hint: 'Backend service is down',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → 503`, action: { type: 'status-code', statusCode: 503, body: JSON.stringify({ error: 'Service unavailable', simulated: true }, null, 2) } }),
  },
  {
    id: 'auth-expired',
    title: 'Session expired',
    effect: 'The backend says the login is no longer valid (401).',
    expect: 'The customer is asked to sign in again, or the session refreshes quietly.',
    label: 'Auth expired 401',
    hint: 'Token refresh and re-login paths',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → 401`, action: { type: 'status-code', statusCode: 401, body: JSON.stringify({ error: 'Token expired', simulated: true }, null, 2) } }),
  },
  {
    id: 'rate-limit',
    title: 'Too many requests',
    effect: 'The backend asks to slow down and retry later (429).',
    expect: 'The page waits or offers retry, and does not loop or spam the backend.',
    label: 'Rate limited 429',
    hint: 'Back-off and retry behaviour',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → 429`, action: { type: 'status-code', statusCode: 429, headers: { 'retry-after': '30' }, body: JSON.stringify({ error: 'Too many requests', simulated: true }, null, 2) } }),
  },
  {
    id: 'slow',
    title: 'Very slow answer',
    effect: 'The real answer arrives, but 5 seconds late.',
    expect: 'A loading indicator shows, and nothing can be clicked twice by accident.',
    label: 'Slow upstream',
    hint: 'Adds 5s before the real response',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → slow`, action: { type: 'passthrough-mutate', delayMs: 5_000, fieldMutations: [] } }),
  },
  {
    id: 'network',
    title: 'Cannot connect',
    effect: 'The backend cannot be reached at all.',
    expect: 'A clear connection error is shown with a way to try again.',
    label: 'Connection failure',
    hint: 'Upstream refuses the connection',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → network error`, action: { type: 'network-error' } }),
  },
  {
    id: 'timeout',
    title: 'No answer (timeout)',
    effect: 'The backend never answers; the call fails after 10 seconds.',
    expect: 'The page stops loading and explains the problem instead of spinning forever.',
    label: 'Upstream timeout',
    hint: 'Hangs, then fails the call',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → timeout`, action: { type: 'timeout', delayMs: 10_000 } }),
  },
  {
    id: 'malformed',
    title: 'Broken data',
    effect: 'The backend sends a cut-off answer that cannot be read.',
    expect: 'The page shows an error message rather than wrong or half-loaded data.',
    label: 'Truncated JSON',
    hint: 'Parser and error-boundary resilience',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → invalid JSON`, action: { type: 'invalid-json' } }),
  },
  {
    id: 'empty',
    title: 'Empty answer',
    effect: 'The backend says OK but sends nothing back.',
    expect: 'The page shows an empty state (for example “No bills yet”), not an error or crash.',
    label: 'Empty 200',
    hint: 'Successful status with no payload',
    apply: (rule) => ({ ...rule, name: `${rule.match.method} ${rule.match.urlPattern} → empty`, action: { type: 'empty-response', statusCode: 200 } }),
  },
];

/** Plain-language names for the status codes testers meet most often. */
const STATUS_NAMES: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'OK, no content', 301: 'Moved', 302: 'Redirect', 304: 'Not changed',
  400: 'Bad request', 401: 'Not signed in', 403: 'Not allowed', 404: 'Not found', 408: 'Took too long',
  409: 'Conflict', 422: 'Invalid data', 429: 'Too many requests',
  500: 'Server error', 502: 'Bad gateway', 503: 'Service down', 504: 'Backend timeout',
};

/** "503 · Service down", or a failure description when there was no response at all. */
export function describeStatus(call: Pick<ServerCall, 'statusCode' | 'error'>): string {
  if (call.statusCode === null) return call.error ? `No response (${call.error})` : 'Still waiting';
  const name = STATUS_NAMES[call.statusCode]
    ?? (call.statusCode < 300 ? 'OK' : call.statusCode < 400 ? 'Redirect' : call.statusCode < 500 ? 'Request problem' : 'Server problem');
  return `${call.statusCode} · ${name}`;
}

/** The host of a call's origin, for labels; falls back to the raw origin. */
export function serverCallHost(call: Pick<ServerCall, 'origin'>): string {
  try {
    return new URL(call.origin).host;
  } catch {
    return call.origin;
  }
}

/**
 * The service a backend call went to, as people name it: `bill-analysis-js`
 * for `bill-analysis-js.dxl-dev-ie.svc.cluster.local:8080`. Hosts outside the
 * cluster keep their full name.
 */
export function serverCallService(call: Pick<ServerCall, 'origin'>): string {
  const host = serverCallHost(call);
  const name = host.replace(/:\d+$/, '');
  if (/\.svc(\.|$)/.test(name) || /^[a-z\d-]+$/i.test(name)) return name.split('.')[0]!;
  return host;
}

/** TM Forum Open API names, so a relay route reads as what it does. */
const TMF_NAMES: Record<string, string> = {
  '620': 'Product Catalog', '621': 'Trouble Ticket', '622': 'Product Ordering', '629': 'Customer', '632': 'Party',
  '633': 'Service Catalog', '635': 'Usage', '637': 'Product Inventory', '638': 'Service Inventory', '639': 'Resource Inventory',
  '640': 'Service Activation', '641': 'Service Ordering', '644': 'Privacy', '645': 'Service Qualification', '646': 'Appointment',
  '648': 'Quote', '651': 'Agreement', '652': 'Resource Ordering', '654': 'Prepay Balance', '663': 'Shopping Cart',
  '666': 'Account', '667': 'Document', '668': 'Partnership', '669': 'Party Role', '670': 'Payment Method', '673': 'Geographic Address',
  '674': 'Geographic Site', '676': 'Payment', '677': 'Usage Consumption', '678': 'Customer Bill', '679': 'Offering Qualification',
  '680': 'Recommendation', '681': 'Communication', '683': 'Party Interaction', '687': 'Stock', '696': 'Risk', '699': 'Sales',
};

/** API paths the BFF calls directly, mapped to their TMF number. */
const TMF_PATHS: Array<[RegExp, string]> = [
  [/\/accountManagement\//i, '666'], [/\/privacyManagement\//i, '644'], [/\/prepayBalanceManagement\//i, '654'],
  [/\/productOrderingManagement\//i, '622'], [/\/productOrdering\//i, '622'], [/\/documentManagement\//i, '667'],
  [/\/customerBillManagement\//i, '678'], [/\/productInventory(Management)?\//i, '637'], [/\/shoppingCart\//i, '663'],
  [/\/troubleTicket\//i, '621'], [/\/paymentManagement\//i, '676'], [/\/usageManagement\//i, '635'],
];

/** `{ id: 'TMF678', name: 'Customer Bill' }` for a relay route or a direct TMF API call; null otherwise. */
export function serverCallTmf(call: Pick<ServerCall, 'layer' | 'path' | 'url' | 'kind'>): { id: string; name: string | null } | null {
  const fromRoute = call.layer ? /^tmf[-_]?(\d{3})$/i.exec(call.layer) : null;
  const number = fromRoute?.[1] ?? (call.kind === 'client' && !call.layer ? TMF_PATHS.find(([pattern]) => pattern.test(call.path || call.url))?.[1] : undefined);
  if (number) return { id: `TMF${number}`, name: TMF_NAMES[number] ?? null };
  if (!call.layer) return null;
  // Other relay routes (document, osb, vesta…) keep their own name.
  const named = call.layer.toLowerCase() === 'document' ? 'Document' : null;
  return { id: call.layer.toUpperCase(), name: named };
}

/** Which layer of the stack a call belongs to, for colour and filters. */
export type ServerLayer = 'page' | 'middleware' | 'cache' | 'service' | 'tmf';

export function serverCallLayer(call: Pick<ServerCall, 'kind' | 'stage' | 'cache' | 'layer' | 'path' | 'url'>): ServerLayer {
  if (call.kind === 'server') return call.stage === 'middleware' ? 'middleware' : 'page';
  if (call.cache === 'hit') return 'cache';
  if (call.layer || serverCallTmf(call)) return 'tmf';
  return 'service';
}

/** One sentence a non-developer can read: who was called, and how it answered. */
export function explainServerCall(call: ServerCall): string {
  if (call.stage === 'middleware' && call.kind === 'server') {
    const outcome = call.statusCode !== null && call.statusCode >= 300 && call.statusCode < 400
      ? ` and redirected the browser (${describeStatus(call)})`
      : call.status === 'error' ? ` and failed (${describeStatus(call)})` : ' and let the request through';
    return `The Edge middleware checked ${call.path} before the page rendered${outcome}, in ${Math.round(call.durationMs)} ms.`;
  }
  if (call.cache === 'hit') {
    return `Next answered ${call.method} ${serverCallHost(call)}${call.path} from its own cache: the backend was not called this time. The data shown is what the page received.`;
  }
  const who = call.layer ? call.serviceName : call.stage === 'middleware' ? 'The Edge middleware' : 'The server';
  const target = call.kind === 'client'
    ? call.layer
      ? `${who} called ${call.layer.toUpperCase()} at ${serverCallHost(call)} (${call.method} ${call.path}), seen by the ApiLens relay,`
      : `${who} called the backend ${serverCallHost(call)} (${call.method} ${call.path})`
    : `The page asked this server for ${call.path} (${call.method})`;
  const answer = call.statusCode === null
    ? call.error ? ' but got no answer.' : '.'
    : ` and got “${describeStatus(call)}” in ${Math.round(call.durationMs)} ms.`;
  const mocked = call.mockedBy ? ` This answer came from your mock “${call.mockedBy}”, not the real backend.` : '';
  return `${target}${answer}${mocked}`;
}

/** Short kind label used across the Server view: what produced this row. */
export function serverCallKindLabel(call: Pick<ServerCall, 'kind' | 'stage' | 'cache' | 'layer'>): string {
  if (call.kind === 'server') return call.stage === 'middleware' ? 'Middleware' : 'Page';
  if (call.layer) return call.layer.toUpperCase();
  return call.cache === 'hit' ? 'Cache' : 'Backend';
}

/** CSS modifier for the kind tag: relay routes share one colour. */
export function serverCallKindClass(call: Pick<ServerCall, 'kind' | 'stage' | 'cache' | 'layer'>): string {
  if (call.kind === 'client' && call.layer) return 'kind-layer';
  return `kind-${serverCallKindLabel(call).toLowerCase()}`;
}
