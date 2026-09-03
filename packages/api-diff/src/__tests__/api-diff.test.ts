import { describe, expect, it } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import type { CapturedRequest } from '@apilens/shared-types';
import { diffHeaders, diffJson, diffJsonSchemaShape, diffResponses } from '../json-diff';
import { compareSessions, schemaRegressions } from '../session-compare';

function req(url: string, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({ sessionId: 's', url, method: 'GET', channel: 'page-hook' }),
    statusCode: 200,
    timing: { startedAt: 0, completedAt: 100, durationMs: 100, injectedDelayMs: null },
    ...overrides,
  };
}

describe('json diff', () => {
  it('detects changed values', () => {
    const diff = diffJson('{"status":"ACTIVE","amount":20}', '{"status":"ACTIVE","amount":25}');
    expect(diff.changedCount).toBe(1);
    expect(diff.entries[0]).toMatchObject({ path: 'amount', kind: 'changed', left: 20, right: 25 });
    expect(diff.identical).toBe(false);
  });

  it('distinguishes a type change from a value change', () => {
    const diff = diffJson('{"amount":20}', '{"amount":null}');
    expect(diff.typeChangedCount).toBe(1);
    expect(diff.entries[0]!.kind).toBe('type-changed');
    expect(diff.entries[0]!.rightType).toBe('null');
  });

  it('detects added and removed leaves', () => {
    const diff = diffJson('{"a":1,"b":2}', '{"a":1,"c":3}');
    expect(diff.removedCount).toBe(1);
    expect(diff.addedCount).toBe(1);
  });

  it('walks nested structures and arrays', () => {
    const diff = diffJson('{"items":[{"price":5},{"price":6}]}', '{"items":[{"price":5},{"price":7}]}');
    expect(diff.entries.map((entry) => entry.path)).toEqual(['items[1].price']);
  });

  it('reports identical payloads', () => {
    expect(diffJson('{"a":1}', '{"a":1}').identical).toBe(true);
  });

  it('honours ignored paths', () => {
    expect(diffJson('{"id":"a","v":1}', '{"id":"b","v":1}', { ignorePaths: ['id'] }).identical).toBe(true);
  });

  it('optionally includes unchanged leaves', () => {
    const diff = diffJson('{"a":1}', '{"a":1}', { includeUnchanged: true });
    expect(diff.entries).toHaveLength(1);
    expect(diff.identical).toBe(true);
  });

  it('reports parse errors instead of throwing', () => {
    expect(diffJson('{bad', '{"a":1}').parseError).toContain('Left side');
    expect(diffJson('{"a":1}', null).parseError).toContain('no body');
  });

  it('compares only shapes when asked', () => {
    expect(diffJsonSchemaShape('{"a":1,"b":"x"}', '{"a":99,"b":"y"}').identical).toBe(true);
    expect(diffJsonSchemaShape('{"a":1}', '{"a":"1"}').identical).toBe(false);
  });
});

describe('header diff', () => {
  it('ignores volatile headers by default', () => {
    const entries = diffHeaders({ date: 'a', 'x-env': 'dev' }, { date: 'b', 'x-env': 'qa' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'x-env', kind: 'changed' });
  });

  it('reports added and removed headers', () => {
    const entries = diffHeaders({ a: '1' }, { b: '2' });
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['added', 'removed']);
  });
});

describe('response diff', () => {
  it('compares status, timing, headers and body together', () => {
    const diff = diffResponses(
      { statusCode: 200, durationMs: 100, headers: { 'x-a': '1' }, body: '{"status":"ACTIVE","amount":20}' },
      { statusCode: 500, durationMs: 350, headers: { 'x-a': '2' }, body: '{"status":"ACTIVE","amount":null}' },
    );
    expect(diff.status.changed).toBe(true);
    expect(diff.durationMs.deltaMs).toBe(250);
    expect(diff.headers).toHaveLength(1);
    expect(diff.body.typeChangedCount).toBe(1);
    expect(diff.textChanged).toBe(true);
  });

  it('falls back to raw text comparison for non-JSON bodies', () => {
    const diff = diffResponses(
      { statusCode: 200, durationMs: 1, headers: {}, body: '<html>a</html>' },
      { statusCode: 200, durationMs: 1, headers: {}, body: '<html>b</html>' },
    );
    expect(diff.body.parseError).not.toBeNull();
    expect(diff.textChanged).toBe(true);
  });
});

describe('session comparison', () => {
  const left = [
    req('https://api.example.com/orders/1', { responseBody: makeBody('{"id":1,"total":10}', 'application/json') }),
    req('https://api.example.com/orders/2', { responseBody: makeBody('{"id":2,"total":20}', 'application/json') }),
    req('https://api.example.com/customer', { responseBody: makeBody('{"name":"a"}', 'application/json') }),
  ];

  const right = [
    req('https://api.example.com/orders/9', {
      statusCode: 500,
      timing: { startedAt: 0, completedAt: 900, durationMs: 900, injectedDelayMs: null },
      responseBody: makeBody('{"id":9,"total":"90"}', 'application/json'),
    }),
    req('https://api.example.com/payment', { responseBody: makeBody('{"ok":true}', 'application/json') }),
  ];

  it('collapses ids so the same endpoint groups together', () => {
    const comparison = compareSessions(left, right, { leftLabel: 'PREPROD', rightLabel: 'PROD' });
    const orders = comparison.endpoints.find((entry) => entry.endpoint.pathTemplate === '/orders/{id}')!;
    expect(orders.leftCount).toBe(2);
    expect(orders.rightCount).toBe(1);
    expect(orders.presence).toBe('both');
  });

  it('lists missing and extra endpoints', () => {
    const comparison = compareSessions(left, right, { leftLabel: 'A', rightLabel: 'B' });
    expect(comparison.missingInRight.map((key) => key.pathTemplate)).toContain('/customer');
    expect(comparison.extraInRight.map((key) => key.pathTemplate)).toContain('/payment');
  });

  it('flags status regressions and slower endpoints', () => {
    const comparison = compareSessions(left, right, { leftLabel: 'A', rightLabel: 'B' });
    expect(comparison.statusRegressions.map((entry) => entry.endpoint.pathTemplate)).toContain('/orders/{id}');
    expect(comparison.slowerInRight[0]!.endpoint.pathTemplate).toBe('/orders/{id}');
  });

  it('detects response schema regressions', () => {
    const comparison = compareSessions(left, right, { leftLabel: 'A', rightLabel: 'B' });
    expect(schemaRegressions(comparison).map((entry) => entry.endpoint.pathTemplate)).toContain('/orders/{id}');
  });

  it('excludes static assets by default', () => {
    const comparison = compareSessions([...left, req('https://api.example.com/app.js')], right, {
      leftLabel: 'A',
      rightLabel: 'B',
    });
    expect(comparison.endpoints.some((entry) => entry.endpoint.pathTemplate === '/app.js')).toBe(false);
  });
});
