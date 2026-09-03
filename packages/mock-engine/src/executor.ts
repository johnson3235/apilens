import type { FieldMutation, NetworkProfile, NetworkProfileId, RuleAction } from '@apilens/shared-types';
import { addJsonPath, deleteJsonPath, nullifyJsonPath, queryJsonPath, safeJsonParse, setJsonPath } from '@apilens/core';

export interface MockOutcome {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  /** Header names the caller must strip from the real response. */
  removeHeaders: string[];
  body: string;
  delayMs: number;
  /** True when the transport must abort instead of returning a response. */
  abort: boolean;
  /** CDP-compatible failure reason when `abort` is true. */
  errorReason: string | null;
  /** True when the rule needs the *real* response before it can be applied. */
  requiresOriginalResponse: boolean;
  networkProfile: NetworkProfileId;
}

export const NETWORK_PROFILES: Record<NetworkProfileId, NetworkProfile> = {
  none: { id: 'none', label: 'No throttling', latencyMs: 0, downloadBytesPerSecond: 0, offline: false },
  'slow-3g': { id: 'slow-3g', label: 'Slow 3G', latencyMs: 400, downloadBytesPerSecond: 50 * 1024, offline: false },
  'fast-3g': { id: 'fast-3g', label: 'Fast 3G', latencyMs: 150, downloadBytesPerSecond: 180 * 1024, offline: false },
  'high-latency': { id: 'high-latency', label: 'High latency', latencyMs: 2_000, downloadBytesPerSecond: 0, offline: false },
  offline: { id: 'offline', label: 'Offline', latencyMs: 0, downloadBytesPerSecond: 0, offline: true },
};

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusTextFor(status: number): string {
  return STATUS_TEXT[status] ?? (status >= 500 ? 'Server Error' : status >= 400 ? 'Client Error' : 'OK');
}

export function defaultErrorBody(status: number, ruleName: string): string {
  return JSON.stringify(
    {
      error: {
        code: status,
        status: statusTextFor(status),
        message: `Simulated by ApiLens rule "${ruleName}".`,
        simulated: true,
      },
    },
    null,
    2,
  );
}

/** Failure types that can only be produced after seeing the genuine response. */
const NEEDS_ORIGINAL: ReadonlySet<string> = new Set([
  'missing-field',
  'null-field',
  'wrong-type',
  'add-field',
  'passthrough',
]);

export function requiresOriginalResponse(action: RuleAction): boolean {
  return NEEDS_ORIGINAL.has(action.type);
}

function cdpErrorReason(action: RuleAction): string {
  if (action.errorReason) return action.errorReason;
  switch (action.type) {
    case 'connection-reset':
      return 'ConnectionReset';
    case 'timeout':
      return 'TimedOut';
    case 'dns-failure':
      return 'NameNotResolved';
    case 'offline':
      return 'InternetDisconnected';
    default:
      return 'Failed';
  }
}

/**
 * Applies JSON field mutations to a real response body.
 *
 * Returns the original text untouched when it is not valid JSON, so a
 * misconfigured rule degrades into a pass-through rather than corrupting data
 * in a way that looks like a genuine backend bug.
 */
export function applyFieldMutations(body: string, mutations: FieldMutation[]): string {
  const parsed = safeJsonParse(body);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return body;

  const target = parsed.value;
  mutations.forEach((mutation) => {
    switch (mutation.operation) {
      case 'delete':
        deleteJsonPath(target, mutation.path);
        break;
      case 'nullify':
        nullifyJsonPath(target, mutation.path);
        break;
      case 'add':
        addJsonPath(target, mutation.path, mutation.value ?? null);
        break;
      case 'set':
        setJsonPath(target, mutation.path, mutation.value ?? null);
        break;
      case 'changeType': {
        const current = queryJsonPath(target, mutation.path)[0];
        setJsonPath(target, mutation.path, coerceToOtherType(current, mutation.targetType));
        break;
      }
      default:
        break;
    }
  });

  return JSON.stringify(target);
}

function coerceToOtherType(value: unknown, targetType: FieldMutation['targetType']): unknown {
  if (targetType) {
    switch (targetType) {
      case 'string':
        return value === null || value === undefined ? 'null' : String(value);
      case 'number':
        return Number.isFinite(Number(value)) ? Number(value) : 0;
      case 'boolean':
        return Boolean(value);
      case 'null':
        return null;
      case 'array':
        return Array.isArray(value) ? value : [value];
      case 'object':
        return value !== null && typeof value === 'object' ? value : { value };
      default:
        return value;
    }
  }
  if (typeof value === 'string') return Number.isFinite(Number(value)) ? Number(value) : 12345;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return { items: value };
  if (value === null) return 'null';
  return JSON.stringify(value);
}

export interface ExecuteOptions {
  ruleName: string;
  /** Real response body, when the transport was able to fetch it first. */
  originalBody?: string | null;
  /** Real response status, used by mutation-style rules. */
  originalStatus?: number | null;
  originalHeaders?: Record<string, string>;
}

/**
 * Turns a rule action into a concrete response the transport layer can serve.
 * Pure and synchronous: delays are described, never awaited here.
 */
export function executeAction(action: RuleAction, options: ExecuteOptions): MockOutcome {
  const headers: Record<string, string> = { ...(action.responseHeaders ?? {}) };
  const removeHeaders = [...(action.removeResponseHeaders ?? [])];
  const profile = action.networkProfile ?? 'none';
  const profileLatency = NETWORK_PROFILES[profile]?.latencyMs ?? 0;

  const outcome: MockOutcome = {
    statusCode: action.statusCode ?? options.originalStatus ?? 200,
    statusText: action.statusText ?? statusTextFor(action.statusCode ?? options.originalStatus ?? 200),
    headers,
    removeHeaders,
    body: action.responseBody ?? '',
    delayMs: (action.delayMs ?? 0) + profileLatency,
    abort: false,
    errorReason: null,
    requiresOriginalResponse: requiresOriginalResponse(action),
    networkProfile: profile,
  };

  switch (action.type) {
    case 'status-code':
      if (!action.responseBody) outcome.body = defaultErrorBody(outcome.statusCode, options.ruleName);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      break;

    case 'custom-body':
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      break;

    case 'auth-expired':
      outcome.statusCode = action.statusCode ?? 401;
      outcome.statusText = statusTextFor(outcome.statusCode);
      outcome.body = action.responseBody ?? defaultErrorBody(outcome.statusCode, options.ruleName);
      headers['content-type'] = 'application/json';
      headers['www-authenticate'] = 'Bearer error="invalid_token", error_description="Simulated expiry"';
      break;

    case 'forbidden':
      outcome.statusCode = 403;
      outcome.statusText = statusTextFor(403);
      outcome.body = action.responseBody ?? defaultErrorBody(403, options.ruleName);
      headers['content-type'] = 'application/json';
      break;

    case 'service-unavailable':
      outcome.statusCode = 503;
      outcome.statusText = statusTextFor(503);
      outcome.body = action.responseBody ?? defaultErrorBody(503, options.ruleName);
      headers['content-type'] = 'application/json';
      headers['retry-after'] = headers['retry-after'] ?? '30';
      break;

    case 'rate-limit':
      outcome.statusCode = 429;
      outcome.statusText = statusTextFor(429);
      outcome.body = action.responseBody ?? defaultErrorBody(429, options.ruleName);
      headers['content-type'] = 'application/json';
      headers['retry-after'] = headers['retry-after'] ?? '60';
      headers['x-ratelimit-limit'] = headers['x-ratelimit-limit'] ?? '100';
      headers['x-ratelimit-remaining'] = '0';
      break;

    case 'empty-response':
      outcome.body = '';
      outcome.statusCode = action.statusCode ?? 200;
      break;

    case 'invalid-json':
      outcome.body = '{"data":{"id":1,"name":"broken"';
      headers['content-type'] = 'application/json';
      break;

    case 'truncated-json':
      outcome.body = '{"data":{"items":[{"id":1},{"id":2},{"id"';
      headers['content-type'] = 'application/json';
      break;

    case 'malformed-headers':
      headers['content-type'] = 'application/json';
      headers['content-length'] = '999999';
      headers['x-apilens-malformed'] = 'true';
      outcome.body = action.responseBody ?? '{"ok":true}';
      break;

    case 'slow-response':
      outcome.delayMs = (action.delayMs ?? 5_000) + profileLatency;
      outcome.requiresOriginalResponse = true;
      break;

    case 'connection-reset':
    case 'timeout':
    case 'dns-failure':
    case 'offline':
    case 'websocket-disconnect':
    case 'sse-interrupt':
      outcome.abort = true;
      outcome.errorReason = cdpErrorReason(action);
      break;

    case 'missing-field':
    case 'null-field':
    case 'wrong-type':
    case 'add-field': {
      const original = options.originalBody ?? action.responseBody ?? '';
      outcome.statusCode = action.statusCode ?? options.originalStatus ?? 200;
      outcome.statusText = statusTextFor(outcome.statusCode);
      outcome.body = applyFieldMutations(original, action.fieldMutations ?? []);
      headers['content-type'] = 'application/json';
      break;
    }

    case 'passthrough':
      outcome.body = options.originalBody ?? '';
      outcome.statusCode = options.originalStatus ?? 200;
      break;

    default:
      break;
  }

  return outcome;
}

/** Headers ApiLens always stamps on a mocked response so it is unmistakable. */
export function mockMarkerHeaders(
  ruleName: string,
  transport: string,
  failureType: string,
): Record<string, string> {
  return {
    'x-apilens-mocked': 'true',
    'x-apilens-rule': ruleName,
    'x-apilens-transport': transport,
    'x-apilens-failure-type': failureType,
  };
}
