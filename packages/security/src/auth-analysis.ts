import type { AuthFlowReport, CapturedRequest, TokenObservation } from '@apilens/shared-types';
import { getHeader, hashString, parseJsonBody } from '@apilens/core';

interface JwtClaims {
  iss?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

function base64UrlDecode(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    if (typeof atob === 'function') return atob(padded);
    return Buffer.from(padded, 'base64').toString('binary');
  } catch {
    return null;
  }
}

/**
 * Reads the *non-sensitive* claims from a JWT so the UI can report lifecycle
 * state without ever displaying the token itself. Signature is never verified
 * — this is observability, not authentication.
 */
export function inspectJwt(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = base64UrlDecode(parts[1]!);
  if (!payload) return null;
  try {
    const claims = JSON.parse(payload) as unknown;
    return claims !== null && typeof claims === 'object' ? (claims as JwtClaims) : null;
  } catch {
    return null;
  }
}

export interface AuthorizationDescriptor {
  scheme: string | null;
  fingerprint: string | null;
  claims: JwtClaims | null;
}

export function describeAuthorization(headerValue: string | undefined): AuthorizationDescriptor {
  if (!headerValue) return { scheme: null, fingerprint: null, claims: null };
  const [scheme, ...rest] = headerValue.split(/\s+/);
  const credential = rest.join(' ') || scheme || '';
  return {
    scheme: rest.length > 0 ? (scheme ?? null) : null,
    fingerprint: credential ? hashString(credential) : null,
    claims: inspectJwt(credential),
  };
}

const REFRESH_HINTS = /(refresh|token|oauth\/token|auth\/renew|connect\/token)/i;
const LOGIN_HINTS = /(login|signin|sign-in|authenticate|oauth\/authorize|session)/i;
const LOGOUT_HINTS = /(logout|signout|sign-out|revoke)/i;

/**
 * Builds an authentication timeline from captured traffic.
 *
 * The report never contains a raw token: only fingerprints, issuer, expiry and
 * derived lifecycle events.
 */
export function analyseAuthFlow(requests: CapturedRequest[]): AuthFlowReport {
  const ordered = [...requests].sort((left, right) => left.timing.startedAt - right.timing.startedAt);
  const observations: TokenObservation[] = [];
  const refreshRetries: Array<{ unauthorizedRequestId: string; retryRequestId: string }> = [];

  let previousFingerprint: string | null = null;
  const unauthorizedByEndpoint = new Map<string, CapturedRequest>();

  for (const request of ordered) {
    const authorization = getHeader(request.requestHeaders, 'authorization');
    const descriptor = describeAuthorization(authorization);
    const timestamp = request.timing.startedAt;
    const expiresAt = descriptor.claims?.exp ? descriptor.claims.exp * 1000 : null;
    const secondsToExpiry = expiresAt !== null ? Math.round((expiresAt - timestamp) / 1000) : null;

    const base: Omit<TokenObservation, 'event' | 'detail'> = {
      requestId: request.id,
      timestamp,
      tokenFingerprint: descriptor.fingerprint,
      issuer: typeof descriptor.claims?.iss === 'string' ? descriptor.claims.iss : null,
      subjectFingerprint: typeof descriptor.claims?.sub === 'string' ? hashString(descriptor.claims.sub) : null,
      expiresAt,
      secondsToExpiry,
      scheme: descriptor.scheme,
    };

    const endpointKey = `${request.method} ${request.hostname}${request.path}`;

    if (request.statusCode === 401) {
      observations.push({ ...base, event: 'unauthorized', detail: `401 on ${endpointKey}` });
      unauthorizedByEndpoint.set(endpointKey, request);
    } else if (request.statusCode === 403) {
      observations.push({ ...base, event: 'forbidden', detail: `403 on ${endpointKey}` });
    } else {
      const previous = unauthorizedByEndpoint.get(endpointKey);
      if (previous && request.statusCode !== null && request.statusCode < 400) {
        refreshRetries.push({ unauthorizedRequestId: previous.id, retryRequestId: request.id });
        unauthorizedByEndpoint.delete(endpointKey);
      }
    }

    if (LOGOUT_HINTS.test(request.path)) {
      observations.push({ ...base, event: 'logout', detail: `Logout endpoint ${endpointKey}` });
    }

    const issuesToken =
      (REFRESH_HINTS.test(request.path) || LOGIN_HINTS.test(request.path)) &&
      request.statusCode !== null &&
      request.statusCode < 400;

    if (issuesToken) {
      const responseTokenFingerprint = extractResponseTokenFingerprint(request);
      observations.push({
        ...base,
        tokenFingerprint: responseTokenFingerprint ?? base.tokenFingerprint,
        event: LOGIN_HINTS.test(request.path) && !REFRESH_HINTS.test(request.path) ? 'token-issued' : 'token-refreshed',
        detail: `${endpointKey} returned ${request.statusCode}`,
      });
      previousFingerprint = responseTokenFingerprint ?? previousFingerprint;
      continue;
    }

    if (descriptor.fingerprint) {
      if (previousFingerprint && previousFingerprint !== descriptor.fingerprint) {
        observations.push({ ...base, event: 'token-refreshed', detail: 'Bearer token changed between requests.' });
      } else if (secondsToExpiry !== null && secondsToExpiry <= 0) {
        observations.push({ ...base, event: 'token-expired', detail: `Token expired ${Math.abs(secondsToExpiry)}s before this call.` });
      } else {
        observations.push({ ...base, event: 'token-present', detail: 'Request carried an authorisation credential.' });
      }
      previousFingerprint = descriptor.fingerprint;
    } else if (request.statusCode === 401) {
      observations.push({ ...base, event: 'token-missing', detail: 'Unauthorised request had no authorisation header.' });
    }
  }

  return {
    observations,
    refreshCount: observations.filter((item) => item.event === 'token-refreshed').length,
    expiredCount: observations.filter((item) => item.event === 'token-expired').length,
    unauthorizedCount: observations.filter((item) => item.event === 'unauthorized').length,
    forbiddenCount: observations.filter((item) => item.event === 'forbidden').length,
    refreshRetries,
  };
}

const TOKEN_KEYS = ['access_token', 'accessToken', 'id_token', 'idToken', 'token'];

function extractResponseTokenFingerprint(request: CapturedRequest): string | null {
  const parsed = parseJsonBody(request.responseBody);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return null;
  const record = parsed.value as Record<string, unknown>;
  for (const key of TOKEN_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return hashString(value);
  }
  return null;
}
