import { createHash, timingSafeEqual } from 'node:crypto';
import type { CallBuffer } from './buffer';
import { sanitizeRule } from './mocks';
import type { ControlHealth, ControlPlaneOptions, ServerMockRule } from './types';
import { CONTROL_PROTOCOL_VERSION } from './types';

/**
 * The in-app control plane.
 *
 * A loopback agent cannot be reached from a remote dev deployment, so the
 * application itself exposes an authenticated, non-indexable endpoint that the
 * extension polls over the same HTTPS origin the tester already uses.
 *
 * Everything here assumes hostile input: the endpoint is reachable by anyone
 * who can reach the app, so the token is the only thing standing between a
 * caller and captured traffic.
 */

export const MIN_TOKEN_LENGTH = 24;

/** Requests allowed per window before the endpoint starts refusing. */
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;
/** Consecutive auth failures before the endpoint locks out for a cool-down. */
const MAX_AUTH_FAILURES = 10;
const LOCKOUT_MS = 60_000;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Length-independent comparison so the token cannot be discovered by timing. */
function tokensMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

function presentedToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1] ?? request.headers.get('x-apilens-control-token');
}

export interface ControlContext {
  options: ControlPlaneOptions;
  processId: string;
  buffer: CallBuffer;
  health: () => ControlHealth;
  getRules: () => ServerMockRule[];
  setRules: (rules: ServerMockRule[]) => void;
  rulesRevision: () => string;
  clearCalls: () => void;
  /** Stores calls relayed by another process of the same app; returns how many were kept. */
  ingest: (calls: unknown[]) => number;
  /** Counts rule applications that happened in another process, so apply budgets hold. */
  consume: (ruleIds: string[]) => void;
}

/** Most calls accepted in one relay request. */
export const MAX_RELAY_BATCH = 50;

export function isTokenAcceptable(token: string | undefined): boolean {
  return typeof token === 'string' && token.length >= MIN_TOKEN_LENGTH;
}

/**
 * Resolves the operation from the request path.
 *
 * The handler is mounted on a catch-all route, so only the trailing segment is
 * meaningful and the mount prefix stays the integrator's choice.
 */
export function resolveOperation(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (!last || last.startsWith('__apilens')) return 'health';
  return last.toLowerCase();
}

export function createControlHandler(context: ControlContext): (request: Request) => Promise<Response> {
  let windowStartedAt = Date.now();
  let windowCount = 0;
  let authFailures = 0;
  let lockedUntil = 0;

  function corsHeaders(request: Request): Record<string, string> {
    const base: Record<string, string> = {
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      vary: 'origin, authorization',
    };
    const origin = request.headers.get('origin');
    // Extension requests carry no page origin and rely on the token alone.
    if (origin && (context.options.allowedOrigins ?? []).includes(origin)) {
      base['access-control-allow-origin'] = origin;
      base['access-control-allow-headers'] = 'authorization, content-type, x-apilens-control-token';
      base['access-control-allow-methods'] = 'GET, PUT, POST, DELETE, OPTIONS';
      base['access-control-max-age'] = '600';
    }
    return base;
  }

  function reply(request: Request, status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request) },
    });
  }

  return async function handleControlRequest(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (!context.options.enabled || !isTokenAcceptable(context.options.token)) {
      // Indistinguishable from an unmounted route, so a disabled control plane
      // never advertises that ApiLens is installed.
      return reply(request, 404, { error: 'Not found' });
    }

    const now = Date.now();
    if (now - windowStartedAt > RATE_WINDOW_MS) {
      windowStartedAt = now;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > RATE_LIMIT) {
      return reply(request, 429, { error: 'Too many control requests. Slow down the poll interval.' });
    }

    if (now < lockedUntil) {
      return reply(request, 429, { error: 'Too many failed authentication attempts. Try again shortly.' });
    }

    const provided = presentedToken(request);
    if (!provided || !tokensMatch(provided, context.options.token)) {
      authFailures += 1;
      if (authFailures >= MAX_AUTH_FAILURES) {
        lockedUntil = now + LOCKOUT_MS;
        authFailures = 0;
      }
      return reply(request, 401, { error: 'Invalid or missing ApiLens control token.' });
    }
    authFailures = 0;

    const url = new URL(request.url);
    const operation = resolveOperation(url.pathname);

    try {
      if (operation === 'health' && request.method === 'GET') {
        return reply(request, 200, context.health());
      }

      if (operation === 'calls') {
        if (request.method === 'GET') {
          const since = Number(url.searchParams.get('since') ?? '0');
          const limit = Number(url.searchParams.get('limit') ?? '200');
          const cursor = Number.isFinite(since) && since > 0 ? Math.trunc(since) : 0;
          const page = context.buffer.since(cursor, Number.isFinite(limit) ? Math.min(Math.trunc(limit), 500) : 200);
          return reply(request, 200, {
            processId: context.processId,
            latestSeq: context.buffer.latestSeq(),
            calls: page.calls,
            gap: page.gap,
          });
        }
        if (request.method === 'DELETE') {
          context.clearCalls();
          return reply(request, 200, { cleared: true, processId: context.processId });
        }
      }

      if (operation === 'ingest' && request.method === 'POST') {
        const payload: unknown = await request.json().catch(() => null);
        const calls = (payload as { calls?: unknown })?.calls;
        if (!Array.isArray(calls) || calls.length > MAX_RELAY_BATCH) {
          return reply(request, 400, { error: `Expected a calls array of at most ${MAX_RELAY_BATCH}.` });
        }
        return reply(request, 200, { accepted: context.ingest(calls), processId: context.processId });
      }

      if (operation === 'consume' && request.method === 'POST') {
        const payload: unknown = await request.json().catch(() => null);
        const ruleIds = (payload as { ruleIds?: unknown })?.ruleIds;
        if (!Array.isArray(ruleIds) || ruleIds.length > 100 || !ruleIds.every((value) => typeof value === 'string')) {
          return reply(request, 400, { error: 'Expected a ruleIds array.' });
        }
        context.consume(ruleIds as string[]);
        return reply(request, 200, { ok: true, processId: context.processId });
      }

      if (operation === 'rules') {
        if (request.method === 'GET') {
          return reply(request, 200, {
            processId: context.processId,
            rules: context.getRules(),
            revision: context.rulesRevision(),
          });
        }
        if (request.method === 'PUT' || request.method === 'POST') {
          if (context.options.allowMockControl === false) {
            return reply(request, 403, { error: 'Server mock control is disabled for this deployment.' });
          }
          const payload: unknown = await request.json().catch(() => null);
          const incoming = Array.isArray(payload)
            ? payload
            : ((payload as { rules?: unknown })?.rules ?? null);
          if (!Array.isArray(incoming)) {
            return reply(request, 400, { error: 'Expected a rules array.' });
          }
          if (incoming.length > 100) {
            return reply(request, 400, { error: 'At most 100 server mock rules are supported.' });
          }
          const existing = new Map(context.getRules().map((rule) => [rule.id, rule]));
          const sanitized = incoming
            .map((rule) => sanitizeRule(rule, Date.now()))
            .filter((rule): rule is ServerMockRule => rule !== null)
            // Apply-budget counters live on the server; a UI round-trip must not reset them.
            .map((rule) => ({ ...rule, appliedCount: existing.get(rule.id)?.appliedCount ?? rule.appliedCount }));
          context.setRules(sanitized);
          return reply(request, 200, {
            processId: context.processId,
            rules: sanitized,
            revision: context.rulesRevision(),
          });
        }
        if (request.method === 'DELETE') {
          if (context.options.allowMockControl === false) {
            return reply(request, 403, { error: 'Server mock control is disabled for this deployment.' });
          }
          context.setRules([]);
          return reply(request, 200, { processId: context.processId, rules: [], revision: context.rulesRevision() });
        }
      }

      return reply(request, 404, { error: `No ApiLens control route for ${request.method} ${operation}.` });
    } catch (error) {
      return reply(request, 500, { error: error instanceof Error ? error.message : 'Control request failed.' });
    }
  };
}

export function buildRulesRevision(rules: ServerMockRule[]): string {
  return createHash('sha256')
    .update(JSON.stringify(rules.map((rule) => [rule.id, rule.enabled, rule.updatedAt])))
    .digest('hex')
    .slice(0, 16);
}

export function emptyHealth(serviceName: string, processId: string, startedAt: number, sdkVersion: string): ControlHealth {
  return {
    ok: true,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    sdkVersion,
    serviceName,
    processId,
    startedAt,
    enabled: false,
    captureRequestBodies: false,
    captureResponseBodies: false,
    maxBodyBytes: 0,
    mockingEnabled: false,
    routeMocksEnabled: false,
    bufferedCalls: 0,
    latestSeq: 0,
    droppedCalls: 0,
    ruleCount: 0,
    activeRuleCount: 0,
    agentDelivery: { accepted: 0, dropped: 0, lastError: null },
  };
}
