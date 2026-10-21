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
  ruleCount: number;
  activeRuleCount: number;
  agentDelivery: { accepted: number; dropped: number; lastError: string | null };
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
  /** Set when the server process restarted, so the UI can reset its cursor. */
  processId: string | null;
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

  calls(since: number, limit = 200): Promise<{ processId: string; latestSeq: number; calls: ServerCall[]; gap: boolean }> {
    return call(this.base, this.options.token, `calls?since=${Math.max(0, Math.trunc(since))}&limit=${limit}`);
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
  /** 0 for an incoming route or an orphan upstream call; 1 for an upstream call under its route. */
  depth: 0 | 1;
  /** Upstream calls listed under this row (routes only). */
  childCount: number;
  /** True for the last upstream call under its route, so the tree connector can close. */
  last: boolean;
}

function isChildOf(child: ServerCall, parent: ServerCall): boolean {
  return child.kind === 'client' && child.traceId === parent.traceId && child.parentSpanId === parent.spanId;
}

/**
 * Orders calls so each incoming route is followed by the upstream calls it made.
 *
 * Upstream calls whose route is not in `calls` (filtered out, or evicted from
 * the server buffer) stay top-level rather than disappearing.
 */
export function groupCallsByRoute(calls: ServerCall[]): ServerFlowRow[] {
  const routes = new Map<string, ServerCall>();
  for (const call of calls) if (call.kind === 'server') routes.set(call.spanId, call);

  const children = new Map<string, ServerCall[]>();
  const roots: ServerCall[] = [];
  for (const call of calls) {
    const parent = call.parentSpanId ? routes.get(call.parentSpanId) : undefined;
    if (parent && isChildOf(call, parent)) {
      const list = children.get(parent.spanId) ?? [];
      list.push(call);
      children.set(parent.spanId, list);
    } else {
      roots.push(call);
    }
  }

  const byStart = (a: ServerCall, b: ServerCall): number => a.startedAt - b.startedAt || a.seq - b.seq;
  const rows: ServerFlowRow[] = [];
  for (const root of roots.sort(byStart)) {
    const own = (children.get(root.spanId) ?? []).sort(byStart);
    rows.push({ call: root, depth: 0, childCount: own.length, last: false });
    own.forEach((child, index) => rows.push({ call: child, depth: 1, childCount: 0, last: index === own.length - 1 }));
  }
  return rows;
}

/** The route that made `call`, and the upstream calls `call` made, from the captured set. */
export function relatedServerCalls(call: ServerCall, calls: ServerCall[]): { parent: ServerCall | null; children: ServerCall[] } {
  const parent = call.parentSpanId
    ? calls.find((candidate) => candidate.kind === 'server' && isChildOf(call, candidate)) ?? null
    : null;
  const children = call.kind === 'server'
    ? calls.filter((candidate) => isChildOf(candidate, call)).sort((a, b) => a.startedAt - b.startedAt)
    : [];
  return { parent, children };
}

/** Builds a server mock rule pre-filled from a captured call. */
export function serverRuleFromCall(call: ServerCall, overrides: Partial<ServerMockRule> = {}): ServerMockRule {
  const now = Date.now();
  return {
    id: `srv-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${call.method} ${call.path} → 503`,
    description: `Created from a captured ${call.kind === 'client' ? 'outbound' : 'incoming'} call on ${call.serviceName}.`,
    enabled: false,
    priority: 100,
    match: {
      method: call.method,
      // Exact path, wildcard origin: survives an environment change without
      // silently widening to every endpoint.
      urlPattern: `*${call.path}`,
      matchType: 'glob',
      kind: call.kind,
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

/** One sentence a non-developer can read: who was called, and how it answered. */
export function explainServerCall(call: ServerCall): string {
  const target = call.kind === 'client'
    ? `The server called the backend ${serverCallHost(call)} (${call.method} ${call.path})`
    : `The page asked this server for ${call.path} (${call.method})`;
  const answer = call.statusCode === null
    ? call.error ? ' but got no answer.' : '.'
    : ` and got “${describeStatus(call)}” in ${Math.round(call.durationMs)} ms.`;
  const mocked = call.mockedBy ? ` This answer came from your mock “${call.mockedBy}”, not the real backend.` : '';
  return `${target}${answer}${mocked}`;
}
