import { describe, expect, it } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import type { CapturedRequest } from '@apilens/shared-types';
import { DEFAULT_REDACTION_POLICY } from '../policy';
import {
  anyUnmaskedSecrets,
  containsLikelySecret,
  redactBodyText,
  redactHeaders,
  redactQueryParams,
  redactRequest,
  redactUrl,
} from '../redaction';
import { analyseAuthFlow, describeAuthorization, inspectJwt } from '../auth-analysis';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJhcGlsZW5zIiwiZXhwIjoyMDAwMDAwMDAwfQ.c2lnbmF0dXJlLXZhbHVl';

function request(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({
      sessionId: 's1',
      url: 'https://api.example.com/customer',
      method: 'GET',
      channel: 'page-hook',
    }),
    ...overrides,
  };
}

describe('header redaction', () => {
  it('masks authorisation and cookie headers', () => {
    const outcome = redactHeaders({ authorization: `Bearer ${JWT}`, cookie: 'sid=1', accept: 'application/json' });
    expect(outcome.value.authorization).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(outcome.value.cookie).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(outcome.value.accept).toBe('application/json');
    expect(outcome.redactedFields).toEqual(['header:authorization', 'header:cookie']);
  });

  it('is case-insensitive on header names', () => {
    expect(redactHeaders({ Authorization: 'Bearer x' }).value.Authorization).toBe(DEFAULT_REDACTION_POLICY.maskToken);
  });

  it('is a no-op when the policy is disabled', () => {
    const outcome = redactHeaders({ authorization: 'Bearer x' }, { ...DEFAULT_REDACTION_POLICY, enabled: false });
    expect(outcome.value.authorization).toBe('Bearer x');
    expect(outcome.redactedFields).toHaveLength(0);
  });
});

describe('query redaction', () => {
  it('masks token-bearing query parameters', () => {
    const outcome = redactQueryParams({ access_token: 'abc', page: '2' });
    expect(outcome.value.access_token).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(outcome.value.page).toBe('2');
  });

  it('rewrites the URL without destroying its structure', () => {
    const outcome = redactUrl('https://a.com/cb?code=secret&state=xyz#frag');
    expect(outcome.value).toContain('state=xyz');
    expect(outcome.value).not.toContain('code=secret');
    expect(outcome.value).toContain('#frag');
  });

  it('leaves URLs without a query string untouched', () => {
    expect(redactUrl('https://a.com/cb').value).toBe('https://a.com/cb');
  });
});

describe('body redaction', () => {
  it('masks credential fields at any depth', () => {
    const outcome = redactBodyText('{"user":{"name":"a","password":"hunter2"},"ok":true}');
    const parsed = JSON.parse(outcome.value) as { user: { name: string; password: string } };
    expect(parsed.user.password).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(parsed.user.name).toBe('a');
    expect(outcome.redactedFields).toContain('body:user.password');
  });

  it('preserves the shape of payment data', () => {
    const outcome = redactBodyText('{"cardNumber":"4111111111111111"}');
    const parsed = JSON.parse(outcome.value) as { cardNumber: string };
    expect(parsed.cardNumber).toMatch(/^•+$/);
    expect(parsed.cardNumber).toHaveLength(16);
  });

  it('masks inline JWTs even in non-JSON payloads', () => {
    const outcome = redactBodyText(`token=${JWT}&x=1`);
    expect(outcome.value).not.toContain(JWT);
    expect(outcome.value).toContain('x=1');
  });

  it('handles arrays of objects', () => {
    const outcome = redactBodyText('[{"secret":"a"},{"secret":"b"}]');
    const parsed = JSON.parse(outcome.value) as Array<{ secret: string }>;
    expect(parsed.every((item) => item.secret === DEFAULT_REDACTION_POLICY.maskToken)).toBe(true);
  });

  it('leaves clean payloads byte-identical', () => {
    const clean = '{"status":"ACTIVE","amount":20}';
    const outcome = redactBodyText(clean);
    expect(outcome.value).toBe(clean);
    expect(outcome.redactedFields).toHaveLength(0);
  });
});

describe('request redaction', () => {
  it('redacts every surface of a captured request', () => {
    const redacted = redactRequest(
      request({
        url: 'https://api.example.com/customer?access_token=abc',
        queryParams: { access_token: 'abc' },
        requestHeaders: { authorization: `Bearer ${JWT}` },
        responseHeaders: { 'set-cookie': 'sid=1' },
        requestBody: makeBody('{"password":"p"}', 'application/json'),
        responseBody: makeBody('{"accessToken":"t"}', 'application/json'),
      }),
    );

    expect(redacted.url).not.toContain('abc');
    expect(redacted.requestHeaders.authorization).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(redacted.responseHeaders['set-cookie']).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(redacted.requestBody?.content).not.toContain('"p"');
    expect(redacted.responseBody?.content).not.toContain('"t"');
    expect(redacted.redactedFields.length).toBeGreaterThan(3);
  });

  it('is idempotent', () => {
    const once = redactRequest(request({ requestHeaders: { authorization: 'Bearer x' } }));
    const twice = redactRequest(once);
    expect(twice.requestHeaders.authorization).toBe(DEFAULT_REDACTION_POLICY.maskToken);
    expect(twice.redactedFields).toEqual(once.redactedFields);
  });
});

describe('secret detection', () => {
  it('flags unmasked JWTs', () => {
    expect(containsLikelySecret(request({ responseBody: makeBody(`{"t":"${JWT}"}`, 'application/json') }))).toBe(true);
    expect(anyUnmaskedSecrets([request()])).toBe(false);
  });
});

describe('auth analysis', () => {
  it('reads JWT claims without exposing the token', () => {
    const claims = inspectJwt(JWT);
    expect(claims?.iss).toBe('apilens');
    const descriptor = describeAuthorization(`Bearer ${JWT}`);
    expect(descriptor.scheme).toBe('Bearer');
    expect(descriptor.fingerprint).not.toContain(JWT);
  });

  it('builds a lifecycle timeline and detects refresh-after-401', () => {
    const report = analyseAuthFlow([
      request({ id: 'r1', path: '/api/orders', statusCode: 401, timing: { startedAt: 1, completedAt: 2, durationMs: 1, injectedDelayMs: null } }),
      request({
        id: 'r2',
        path: '/auth/refresh',
        method: 'POST',
        statusCode: 200,
        responseBody: makeBody('{"access_token":"new-token"}', 'application/json'),
        timing: { startedAt: 3, completedAt: 4, durationMs: 1, injectedDelayMs: null },
      }),
      request({ id: 'r3', path: '/api/orders', statusCode: 200, timing: { startedAt: 5, completedAt: 6, durationMs: 1, injectedDelayMs: null } }),
    ]);

    expect(report.unauthorizedCount).toBe(1);
    expect(report.refreshCount).toBeGreaterThanOrEqual(1);
    expect(report.refreshRetries).toEqual([{ unauthorizedRequestId: 'r1', retryRequestId: 'r3' }]);
    expect(report.observations.every((item) => !JSON.stringify(item).includes(JWT))).toBe(true);
  });

  it('reports an expired token', () => {
    const expiredJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig';
    const report = analyseAuthFlow([
      request({ id: 'r1', requestHeaders: { authorization: `Bearer ${expiredJwt}` }, statusCode: 200 }),
    ]);
    expect(report.expiredCount).toBe(1);
  });
});
