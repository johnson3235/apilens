import type {
  MockSkipReason,
  ServerFieldMutation,
  ServerMockAction,
  ServerMockRule,
} from './types';
import { applyPath, coerceType, getPath } from './json-path';

/**
 * Server-side failure simulation.
 *
 * Browser mocks stop at the network boundary, so they cannot exercise what a
 * BFF does when *its* upstream misbehaves. These rules run inside the Node
 * process, between the route handler and the upstream service.
 */

const MAX_PATTERN_LENGTH = 512;

export interface MockCandidate {
  kind: 'client' | 'server';
  method: string;
  url: string;
  headers: Headers;
  /** Already-captured request text, when available. */
  bodyText: string | null;
  sessionId: string;
}

function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, caseSensitive ? '' : 'i');
}

function matchesUrl(rule: ServerMockRule, url: string): boolean {
  const pattern = rule.match.urlPattern ?? '';
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return !pattern;
  try {
    switch (rule.match.matchType) {
      case 'regex':
        return new RegExp(pattern, 'i').test(url);
      case 'contains':
        return url.toLowerCase().includes(pattern.toLowerCase());
      case 'equals':
        return url.toLowerCase() === pattern.toLowerCase();
      case 'startsWith':
        return url.toLowerCase().startsWith(pattern.toLowerCase());
      case 'glob':
      default:
        return globToRegExp(pattern, false).test(url);
    }
  } catch {
    // A malformed pattern must never match everything.
    return false;
  }
}

function describeMismatch(rule: ServerMockRule, candidate: MockCandidate): string | null {
  const wantedKind = rule.match.kind ?? 'any';
  if (wantedKind !== 'any' && wantedKind !== candidate.kind) {
    return `Rule targets ${wantedKind} calls; this is a ${candidate.kind} call.`;
  }
  const method = (rule.match.method || 'ANY').toUpperCase();
  if (method !== 'ANY' && method !== candidate.method.toUpperCase()) {
    return `Rule targets ${method}; this request is ${candidate.method.toUpperCase()}.`;
  }
  if (!matchesUrl(rule, candidate.url)) {
    return `URL did not match ${rule.match.matchType} pattern "${rule.match.urlPattern}".`;
  }
  if (rule.match.sessionId && rule.match.sessionId !== candidate.sessionId) {
    return 'Rule is scoped to a different QA session.';
  }
  if (rule.match.headerName) {
    const value = candidate.headers.get(rule.match.headerName);
    if (value === null) return `Header "${rule.match.headerName}" was not present.`;
    if (rule.match.headerValue && !value.toLowerCase().includes(rule.match.headerValue.toLowerCase())) {
      return `Header "${rule.match.headerName}" did not contain "${rule.match.headerValue}".`;
    }
  }
  if (rule.match.bodyContains) {
    if (candidate.bodyText === null) return 'Rule matches on the body, but the body was not captured.';
    if (!candidate.bodyText.toLowerCase().includes(rule.match.bodyContains.toLowerCase())) {
      return 'Request body did not contain the expected text.';
    }
  }
  return null;
}

function budgetReason(rule: ServerMockRule): string | null {
  switch (rule.applyMode) {
    case 'once':
      return rule.appliedCount >= 1 ? 'Rule is set to apply once and has already fired.' : null;
    case 'n-times': {
      const limit = rule.applyLimit ?? 1;
      return rule.appliedCount >= limit ? `Rule reached its limit of ${limit} applications.` : null;
    }
    case 'after-n': {
      const skip = rule.applyLimit ?? 0;
      return rule.appliedCount < skip ? `Rule starts applying after ${skip} matching calls.` : null;
    }
    default:
      return null;
  }
}

export interface MockDecision {
  rule: ServerMockRule | null;
  skipped: MockSkipReason[];
}

export function selectMockRule(rules: ServerMockRule[], candidate: MockCandidate): MockDecision {
  const skipped: MockSkipReason[] = [];
  const ordered = [...rules].sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt);

  for (const rule of ordered) {
    if (!rule.enabled) continue;
    const mismatch = describeMismatch(rule, candidate);
    if (mismatch) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: mismatch });
      continue;
    }
    const exhausted = budgetReason(rule);
    if (exhausted) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: exhausted });
      continue;
    }
    return { rule, skipped };
  }
  return { rule: null, skipped };
}

export function applyFieldMutations(text: string, mutations: ServerFieldMutation[]): string {
  if (mutations.length === 0) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Mutations are JSON-only by definition; leave other payloads untouched.
    return text;
  }
  for (const mutation of mutations) {
    if (!mutation?.path) continue;
    switch (mutation.operation) {
      case 'delete':
        applyPath(parsed, mutation.path, 'delete');
        break;
      case 'nullify':
        applyPath(parsed, mutation.path, 'nullify');
        break;
      case 'changeType':
        applyPath(parsed, mutation.path, 'set', coerceType(getPath(parsed, mutation.path), mutation.targetType ?? 'string'));
        break;
      case 'set':
      default:
        applyPath(parsed, mutation.path, 'set', mutation.value);
        break;
    }
  }
  return JSON.stringify(parsed);
}

export function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

/** Thrown to reproduce a transport-level failure a status code cannot express. */
export class MockNetworkError extends TypeError {
  constructor(message: string, readonly ruleName: string) {
    super(message);
    this.name = 'TypeError';
  }
}

/**
 * Makes a value safe for an HTTP header.
 *
 * Rule names are user-supplied and routinely contain characters like `→`,
 * which throw when assigned to a header. A mock must never crash the request
 * it is decorating.
 */
export function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7E]/g, '?').slice(0, 128) || 'apilens-rule';
}

function mockHeaders(action: ServerMockAction, ruleName: string, fallbackType: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(action.headers ?? {})) {
    try {
      headers.set(name, headerSafe(String(value)));
    } catch {
      // A header name the platform rejects is skipped rather than fatal.
    }
  }
  if (!headers.has('content-type')) headers.set('content-type', fallbackType);
  headers.set('x-apilens-mock', headerSafe(ruleName));
  return headers;
}

/**
 * Builds the synthetic response for a matched rule.
 *
 * `passthrough-mutate` is handled by the caller because it needs the real
 * upstream response; everything else is produced without a network call.
 */
export async function buildMockResponse(
  rule: ServerMockRule,
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  const action = rule.action;
  await delay(Math.max(0, Math.min(action.delayMs ?? 0, 120_000)), signal);

  switch (action.type) {
    case 'network-error':
      throw new MockNetworkError('fetch failed', rule.name);

    case 'timeout': {
      await delay(Math.max(1_000, Math.min(action.delayMs ?? 30_000, 120_000)), signal);
      throw new MockNetworkError('fetch failed: upstream timed out', rule.name);
    }

    case 'empty-response':
      return new Response('', {
        status: action.statusCode ?? 200,
        statusText: action.statusText ? headerSafe(action.statusText) : '',
        headers: mockHeaders(action, rule.name, 'application/json'),
      });

    case 'invalid-json': {
      const source = action.body?.trim() || '{"data":{"items":[{"id":1}';
      return new Response(source.slice(0, Math.max(1, source.length - 1)), {
        status: action.statusCode ?? 200,
        headers: mockHeaders(action, rule.name, 'application/json'),
      });
    }

    case 'custom-body':
    case 'status-code':
    default: {
      const status = action.statusCode ?? (action.type === 'custom-body' ? 200 : 500);
      const body =
        action.body ??
        JSON.stringify({
          error: 'ApiLens simulated failure',
          rule: rule.name,
          status,
          simulated: true,
        });
      const isJson = /^\s*[[{"]/.test(body);
      return new Response(status === 204 || status === 304 ? null : body, {
        status,
        statusText: action.statusText ? headerSafe(action.statusText) : '',
        headers: mockHeaders(action, rule.name, isJson ? 'application/json' : 'text/plain; charset=utf-8'),
      });
    }
  }
}

/** Normalises a rule that arrived over the control plane. */
export function sanitizeRule(input: unknown, now: number): ServerMockRule | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<ServerMockRule>;
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id.slice(0, 128) : null;
  if (!id) return null;
  const match = (raw.match ?? {}) as Partial<ServerMockRule['match']>;
  const action = (raw.action ?? {}) as Partial<ServerMockAction>;
  const statusCode = typeof action.statusCode === 'number' ? Math.min(599, Math.max(100, Math.trunc(action.statusCode))) : undefined;

  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 200) : `Rule ${id.slice(0, 8)}`,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 500) : '',
    enabled: raw.enabled === true,
    priority: typeof raw.priority === 'number' ? raw.priority : 100,
    match: {
      method: typeof match.method === 'string' ? match.method.toUpperCase().slice(0, 16) : 'ANY',
      urlPattern: typeof match.urlPattern === 'string' ? match.urlPattern.slice(0, MAX_PATTERN_LENGTH) : '',
      matchType: (['glob', 'regex', 'contains', 'equals', 'startsWith'] as const).includes(match.matchType as never)
        ? (match.matchType as ServerMockRule['match']['matchType'])
        : 'glob',
      kind: (['client', 'server', 'any'] as const).includes(match.kind as never) ? (match.kind as 'client' | 'server' | 'any') : 'client',
      bodyContains: typeof match.bodyContains === 'string' ? match.bodyContains.slice(0, 500) : undefined,
      headerName: typeof match.headerName === 'string' ? match.headerName.slice(0, 128) : undefined,
      headerValue: typeof match.headerValue === 'string' ? match.headerValue.slice(0, 256) : undefined,
      sessionId: typeof match.sessionId === 'string' && match.sessionId ? match.sessionId.slice(0, 128) : null,
    },
    action: {
      type: (
        ['status-code', 'custom-body', 'empty-response', 'invalid-json', 'network-error', 'timeout', 'passthrough-mutate'] as const
      ).includes(action.type as never)
        ? (action.type as ServerMockAction['type'])
        : 'status-code',
      statusCode,
      statusText: typeof action.statusText === 'string' ? action.statusText.slice(0, 128) : undefined,
      body: typeof action.body === 'string' ? action.body.slice(0, 1024 * 1024) : undefined,
      headers:
        action.headers && typeof action.headers === 'object'
          ? Object.fromEntries(
              Object.entries(action.headers)
                .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
                .slice(0, 32)
                .map(([key, value]) => [key.slice(0, 128), String(value).slice(0, 1024)]),
            )
          : undefined,
      delayMs: typeof action.delayMs === 'number' ? Math.min(120_000, Math.max(0, Math.trunc(action.delayMs))) : undefined,
      fieldMutations: Array.isArray(action.fieldMutations)
        ? action.fieldMutations
            .filter((mutation): mutation is ServerFieldMutation => Boolean(mutation) && typeof mutation.path === 'string')
            .slice(0, 50)
        : undefined,
    },
    applyMode: (['always', 'once', 'n-times', 'after-n'] as const).includes(raw.applyMode as never)
      ? (raw.applyMode as ServerMockRule['applyMode'])
      : 'always',
    applyLimit: typeof raw.applyLimit === 'number' ? Math.max(0, Math.trunc(raw.applyLimit)) : undefined,
    appliedCount: typeof raw.appliedCount === 'number' ? Math.max(0, Math.trunc(raw.appliedCount)) : 0,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: now,
  };
}
