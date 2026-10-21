import type { CapturedRequest, RequestType } from '@apilens/shared-types';

/**
 * Keyword query language for captured traffic.
 *
 * A QA engineer should be able to type what they mean — `billing status:5xx
 * -image` — without learning a DSL first. Plain words work on their own, and
 * every advanced form is discoverable from the in-panel help table below.
 *
 * Parsing is deliberately forgiving: an unfinished or malformed query narrows
 * nothing rather than throwing away the tester's results mid-keystroke.
 */

export type TrafficClass = 'api' | 'documents' | 'assets' | 'all';

const API_TYPES = new Set<RequestType>(['fetch', 'xhr', 'graphql', 'sse', 'websocket', 'beacon', 'form', 'server']);

export const TRAFFIC_CLASSES: Array<{ id: TrafficClass; label: string; hint: string }> = [
  { id: 'api', label: 'API calls', hint: 'Fetch, XHR, GraphQL, SSE, WebSocket and beacons' },
  { id: 'documents', label: 'Pages', hint: 'Document navigations only' },
  { id: 'assets', label: 'Assets', hint: 'Scripts, styles, images, fonts and media' },
  { id: 'all', label: 'Everything', hint: 'No traffic-type filter at all' },
];

export function matchesTrafficClass(request: CapturedRequest, traffic: TrafficClass): boolean {
  switch (traffic) {
    case 'api':
      return API_TYPES.has(request.type);
    case 'documents':
      return request.type === 'navigation';
    case 'assets':
      return request.type === 'static';
    case 'all':
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* Page scoping                                                        */
/* ------------------------------------------------------------------ */

export type PageScope = { mode: 'all' } | { mode: 'current' } | { mode: 'page'; key: string };

/**
 * Identity of the page a call belongs to.
 *
 * Origin plus pathname: a SPA route is a meaningful "page" to a tester, while
 * query strings would split one screen into dozens of unrelated groups.
 */
export function pageKeyOf(pageUrl: string | null | undefined): string | null {
  if (!pageUrl) return null;
  try {
    const url = new URL(pageUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return null;
  }
}

export function pageLabelOf(key: string): string {
  try {
    const url = new URL(key);
    return url.pathname === '/' ? url.hostname : url.pathname;
  } catch {
    return key;
  }
}

export interface PageGroup {
  key: string;
  label: string;
  hostname: string;
  count: number;
  errorCount: number;
  lastActivityAt: number;
}

/** Pages seen in this session, most recently active first. */
export function groupByPage(requests: CapturedRequest[]): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  for (const request of requests) {
    const key = pageKeyOf(request.pageUrl);
    if (!key) continue;
    let hostname = '';
    try {
      hostname = new URL(key).hostname;
    } catch {
      hostname = '';
    }
    const existing = groups.get(key) ?? { key, label: pageLabelOf(key), hostname, count: 0, errorCount: 0, lastActivityAt: 0 };
    existing.count += 1;
    if (request.error || (request.statusCode ?? 0) >= 400) existing.errorCount += 1;
    existing.lastActivityAt = Math.max(existing.lastActivityAt, request.timing.startedAt);
    groups.set(key, existing);
  }
  return [...groups.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

export function matchesPageScope(request: CapturedRequest, scope: PageScope, currentPageKey: string | null): boolean {
  if (scope.mode === 'all') return true;
  const key = pageKeyOf(request.pageUrl);
  if (scope.mode === 'current') {
    // Without a known page we show the call rather than hiding evidence.
    return currentPageKey === null || key === null || key === currentPageKey;
  }
  return key === scope.key;
}

/* ------------------------------------------------------------------ */
/* Keyword query                                                       */
/* ------------------------------------------------------------------ */

export type QueryField =
  | 'text'
  | 'method'
  | 'status'
  | 'host'
  | 'path'
  | 'url'
  | 'type'
  | 'page'
  | 'body'
  | 'header'
  | 'query'
  | 'mock'
  | 'error'
  | 'slow'
  | 'trace'
  | 'service';

export interface QueryTerm {
  field: QueryField;
  /** Comma-separated alternatives behave as OR within one term. */
  values: string[];
  negate: boolean;
  /** Original token, so the UI can render removable chips. */
  raw: string;
}

export interface ParsedQuery {
  terms: QueryTerm[];
  /** True when the query narrows nothing. */
  empty: boolean;
}

export const QUERY_HELP: Array<{ example: string; meaning: string }> = [
  { example: 'billing', meaning: 'Match anywhere: URL, method, status, service or page' },
  { example: '"order summary"', meaning: 'Match an exact phrase' },
  { example: '-image', meaning: 'Exclude anything matching the term' },
  { example: 'status:500', meaning: 'Exact status code' },
  { example: 'status:4xx,5xx', meaning: 'Status buckets; a comma means "or"' },
  { example: 'status:>=400', meaning: 'Comparison — also >, <, <=' },
  { example: 'method:POST,PUT', meaning: 'One or more HTTP methods' },
  { example: 'host:api.vodafone', meaning: 'Hostname contains' },
  { example: 'path:/v2/billing', meaning: 'Path contains' },
  { example: 'type:xhr', meaning: 'fetch, xhr, graphql, sse, websocket, static, navigation' },
  { example: 'page:/myaccount', meaning: 'Only calls made from a matching page' },
  { example: 'body:contactId', meaning: 'Search request and response payloads' },
  { example: 'header:authorization', meaning: 'Header name present (or name=value)' },
  { example: 'query:contactId=3055861', meaning: 'Query-string parameter' },
  { example: 'mock:yes', meaning: 'Only mocked (or mock:no for real) responses' },
  { example: 'error:yes', meaning: 'Failed calls only' },
  { example: 'slow:>1000', meaning: 'Duration in milliseconds' },
  { example: 'trace:4bf92f', meaning: 'Trace or correlation id contains' },
];

const FIELD_ALIASES: Record<string, QueryField> = {
  method: 'method', m: 'method', verb: 'method',
  status: 'status', code: 'status', s: 'status',
  host: 'host', hostname: 'host', domain: 'host', h: 'host',
  path: 'path', p: 'path',
  url: 'url', u: 'url',
  type: 'type', kind: 'type', t: 'type',
  page: 'page', screen: 'page',
  body: 'body', payload: 'body',
  header: 'header', headers: 'header',
  query: 'query', param: 'query', q: 'query',
  mock: 'mock', mocked: 'mock',
  error: 'error', failed: 'error',
  slow: 'slow', duration: 'slow', time: 'slow', ms: 'slow',
  trace: 'trace', correlation: 'trace',
  service: 'service', svc: 'service',
};

/** Splits on whitespace while keeping quoted phrases intact. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    if (value.trim()) tokens.push(value);
  }
  return tokens;
}

export function parseQuery(input: string): ParsedQuery {
  const terms: QueryTerm[] = [];
  for (const rawToken of tokenize(input)) {
    const negate = rawToken.startsWith('-') && rawToken.length > 1;
    const token = negate ? rawToken.slice(1) : rawToken;
    const separator = token.indexOf(':');

    if (separator > 0) {
      const name = token.slice(0, separator).toLowerCase();
      const field = FIELD_ALIASES[name];
      if (field) {
        const value = token.slice(separator + 1).replace(/^["']|["']$/g, '');
        const values = value.split(',').map((item) => item.trim()).filter(Boolean);
        if (values.length > 0) {
          terms.push({ field, values, negate, raw: rawToken });
          continue;
        }
      }
    }

    // Anything else — including an unknown prefix — is honest free text.
    terms.push({ field: 'text', values: [token.toLowerCase()], negate, raw: rawToken });
  }
  return { terms, empty: terms.length === 0 };
}

function haystack(request: CapturedRequest): string {
  return [
    request.method,
    request.url,
    request.path,
    request.hostname,
    request.statusCode ?? '',
    request.type,
    request.serviceName ?? '',
    request.pageUrl ?? '',
    request.graphql?.operationName ?? '',
    request.error ?? '',
    request.mock?.ruleName ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function bodyText(request: CapturedRequest): string {
  return `${request.requestBody?.content ?? ''} ${request.responseBody?.content ?? ''}`.toLowerCase();
}

function matchesStatus(request: CapturedRequest, value: string): boolean {
  const status = request.statusCode;
  const comparison = /^(>=|<=|>|<)\s*(\d+)$/.exec(value);
  if (comparison) {
    if (status === null) return false;
    const bound = Number(comparison[2]);
    switch (comparison[1]) {
      case '>': return status > bound;
      case '<': return status < bound;
      case '>=': return status >= bound;
      default: return status <= bound;
    }
  }
  const bucket = /^([1-5])xx$/i.exec(value);
  if (bucket) return status !== null && Math.floor(status / 100) === Number(bucket[1]);
  if (/^(err|error|failed)$/i.test(value)) return request.error !== null;
  if (/^ok$/i.test(value)) return status !== null && status < 400 && !request.error;
  const exact = Number(value);
  return Number.isFinite(exact) && status === exact;
}

function matchesDuration(request: CapturedRequest, value: string): boolean {
  const duration = request.timing.durationMs;
  if (duration === null) return false;
  const comparison = /^(>=|<=|>|<)?\s*(\d+)$/.exec(value);
  if (!comparison) return false;
  const bound = Number(comparison[2]);
  switch (comparison[1]) {
    case '<': return duration < bound;
    case '<=': return duration <= bound;
    case '>=': return duration >= bound;
    default: return duration > bound;
  }
}

function matchesBoolean(value: string, actual: boolean): boolean {
  return /^(yes|true|1|only)$/i.test(value) ? actual : /^(no|false|0)$/i.test(value) ? !actual : actual;
}

function matchesHeader(request: CapturedRequest, value: string): boolean {
  const [name, expected] = value.split('=');
  const key = (name ?? '').toLowerCase();
  const entries = [...Object.entries(request.requestHeaders), ...Object.entries(request.responseHeaders)];
  return entries.some(([headerName, headerValue]) => {
    if (!headerName.toLowerCase().includes(key)) return false;
    return expected === undefined || String(headerValue).toLowerCase().includes(expected.toLowerCase());
  });
}

function matchesQueryParam(request: CapturedRequest, value: string): boolean {
  const [name, expected] = value.split('=');
  const key = (name ?? '').toLowerCase();
  return Object.entries(request.queryParams).some(([paramName, paramValue]) => {
    if (!paramName.toLowerCase().includes(key)) return false;
    return expected === undefined || String(paramValue).toLowerCase().includes(expected.toLowerCase());
  });
}

function matchesTerm(request: CapturedRequest, term: QueryTerm): boolean {
  return term.values.some((rawValue) => {
    const value = rawValue.toLowerCase();
    switch (term.field) {
      case 'method': return request.method.toLowerCase() === value;
      case 'status': return matchesStatus(request, rawValue);
      case 'host': return request.hostname.toLowerCase().includes(value);
      case 'path': return request.path.toLowerCase().includes(value);
      case 'url': return request.url.toLowerCase().includes(value);
      case 'type': return request.type.toLowerCase() === value;
      case 'page': return (request.pageUrl ?? '').toLowerCase().includes(value);
      case 'body': return bodyText(request).includes(value);
      case 'header': return matchesHeader(request, rawValue);
      case 'query': return matchesQueryParam(request, rawValue);
      case 'mock': return matchesBoolean(rawValue, request.mock !== null);
      case 'error': return matchesBoolean(rawValue, request.error !== null || (request.statusCode ?? 0) >= 400);
      case 'slow': return matchesDuration(request, rawValue);
      case 'trace': return `${request.traceId ?? ''} ${request.correlationId ?? ''} ${request.spanId ?? ''}`.toLowerCase().includes(value);
      case 'service': return (request.serviceName ?? '').toLowerCase().includes(value);
      case 'text':
      default: return haystack(request).includes(value);
    }
  });
}

export function matchesQuery(request: CapturedRequest, query: ParsedQuery): boolean {
  return query.terms.every((term) => (term.negate ? !matchesTerm(request, term) : matchesTerm(request, term)));
}

export interface FilterInput {
  query: string;
  traffic: TrafficClass;
  scope: PageScope;
  currentPageKey: string | null;
}

export interface FilterOutcome {
  requests: CapturedRequest[];
  parsed: ParsedQuery;
  /** Counts for honest "why is my call missing?" messaging. */
  total: number;
  hiddenByTraffic: number;
  hiddenByScope: number;
  hiddenByQuery: number;
}

/**
 * Applies every filter and reports what each one removed.
 *
 * The counts matter as much as the result: "0 shown" is useless, while
 * "48 hidden by Assets filter" tells the tester exactly which control to undo.
 */
export function filterRequests(requests: CapturedRequest[], input: FilterInput): FilterOutcome {
  const parsed = parseQuery(input.query);
  let hiddenByTraffic = 0;
  let hiddenByScope = 0;
  let hiddenByQuery = 0;
  const result: CapturedRequest[] = [];

  for (const request of requests) {
    if (!matchesTrafficClass(request, input.traffic)) { hiddenByTraffic += 1; continue; }
    if (!matchesPageScope(request, input.scope, input.currentPageKey)) { hiddenByScope += 1; continue; }
    if (!parsed.empty && !matchesQuery(request, parsed)) { hiddenByQuery += 1; continue; }
    result.push(request);
  }

  return { requests: result, parsed, total: requests.length, hiddenByTraffic, hiddenByScope, hiddenByQuery };
}

/** Removes one chip from a query string without disturbing the rest. */
export function removeTerm(query: string, raw: string): string {
  return tokenize(query)
    .filter((token) => token !== raw)
    .map((token) => (/\s/.test(token) ? `"${token}"` : token))
    .join(' ');
}

/** Adds a term if it is not already present, for click-to-filter affordances. */
export function addTerm(query: string, raw: string): string {
  const tokens = tokenize(query);
  if (tokens.includes(raw)) return query;
  return [...tokens.map((token) => (/\s/.test(token) ? `"${token}"` : token)), raw].join(' ').trim();
}
