import { describe, expect, it } from 'vitest';
import { groupCallsByRoute, normalizeControlUrl, relatedServerCalls, serverRuleFromCall, type ServerCall } from './server-control';
import { serverCallToSpan } from '../background/server-bridge';

const call: ServerCall = {
  seq: 7,
  spanId: 'span-1',
  traceId: 'trace-1',
  parentSpanId: null,
  sessionId: 'qa-1',
  scenarioId: null,
  serviceName: 'clear-app-bff',
  kind: 'client',
  method: 'POST',
  url: 'https://api.example.com/v2/billing',
  origin: 'https://api.example.com',
  path: '/v2/billing',
  query: { contactId: '3055861' },
  statusCode: 200,
  status: 'ok',
  startedAt: 1_000,
  endedAt: 1_250,
  durationMs: 250,
  bodyDurationMs: 260,
  requestHeaders: { 'content-type': 'application/json' },
  responseHeaders: { 'content-type': 'application/json' },
  requestBody: { content: '{"a":1}', encoding: 'utf8', contentType: 'application/json', byteLength: 7, truncated: false, redacted: false },
  responseBody: { content: '{"b":2}', encoding: 'utf8', contentType: 'application/json', byteLength: 7, truncated: false, redacted: true },
  requestBodyOmitted: null,
  responseBodyOmitted: null,
  error: null,
  mockedBy: null,
};

describe('normalizeControlUrl', () => {
  it('appends the conventional mount path to a bare origin', () => {
    expect(normalizeControlUrl('https://clear-app-dev.example.com')).toBe('https://clear-app-dev.example.com/api/__apilens');
  });

  it('keeps an explicit mount path and drops trailing slashes', () => {
    expect(normalizeControlUrl('https://host.example.com/api/__apilens/')).toBe('https://host.example.com/api/__apilens');
  });

  it('assumes HTTPS when the tester omits the scheme', () => {
    expect(normalizeControlUrl('host.example.com/api/__apilens')).toBe('https://host.example.com/api/__apilens');
  });

  it('assumes plain HTTP for a bare local dev address', () => {
    expect(normalizeControlUrl('localhost:3100')).toBe('http://localhost:3100/api/__apilens');
    expect(normalizeControlUrl('127.0.0.1:3000/api/__apilens')).toBe('http://127.0.0.1:3000/api/__apilens');
    expect(normalizeControlUrl('localhost.example.com')).toBe('https://localhost.example.com/api/__apilens');
  });

  it('strips credentials, query and fragment so they are never sent or displayed', () => {
    expect(normalizeControlUrl('https://user:pass@host.example.com/api/__apilens?token=leak#frag')).toBe(
      'https://host.example.com/api/__apilens',
    );
  });

  it('returns an empty string for blank input rather than throwing', () => {
    expect(normalizeControlUrl('   ')).toBe('');
  });
});

describe('serverCallToSpan', () => {
  it('maps a captured call onto the shared trace span shape', () => {
    const span = serverCallToSpan(call);
    expect(span).toMatchObject({
      spanId: 'span-1',
      traceId: 'trace-1',
      kind: 'client',
      channel: 'server-sdk',
      source: 'internal-service',
      statusCode: 200,
      durationMs: 250,
    });
    expect(span.attributes.responseBody).toBe('{"b":2}');
    expect(span.attributes.timingScope).toBe('response-body');
  });

  it('reports header-only timing when no body was captured', () => {
    const span = serverCallToSpan({ ...call, bodyDurationMs: null, responseBody: null, requestBody: null });
    expect(span.attributes.timingScope).toBe('response-headers');
    expect(span.attributes.bodyCapture).toBe(false);
  });
});

describe('serverRuleFromCall', () => {
  it('creates a disabled, path-scoped rule so nothing fires by accident', () => {
    const rule = serverRuleFromCall(call);
    expect(rule.enabled).toBe(false);
    expect(rule.match.urlPattern).toBe('*/v2/billing');
    expect(rule.match.method).toBe('POST');
    expect(rule.match.kind).toBe('client');
    expect(rule.action.statusCode).toBe(503);
  });

  it('targets incoming routes when the source call was one', () => {
    expect(serverRuleFromCall({ ...call, kind: 'server' }).match.kind).toBe('server');
  });
});

describe('groupCallsByRoute', () => {
  const route: ServerCall = { ...call, seq: 3, spanId: 'route-1', kind: 'server', path: '/api/checkout', startedAt: 100 };
  const customer: ServerCall = { ...call, seq: 1, spanId: 'up-1', parentSpanId: 'route-1', path: '/api/customers/1', startedAt: 110 };
  const payment: ServerCall = { ...call, seq: 2, spanId: 'up-2', parentSpanId: 'route-1', path: '/api/payments', startedAt: 120 };
  const earlier: ServerCall = { ...call, seq: 4, spanId: 'route-0', kind: 'server', path: '/api/cart', startedAt: 50 };

  it('lists each route before the upstream calls it made, in start order', () => {
    const rows = groupCallsByRoute([payment, customer, route, earlier]);
    expect(rows.map((row) => [row.call.spanId, row.depth, row.childCount, row.last])).toEqual([
      ['route-0', 0, 0, false],
      ['route-1', 0, 2, false],
      ['up-1', 1, 0, false],
      ['up-2', 1, 0, true],
    ]);
  });

  it('keeps upstream calls whose route is missing at the top level', () => {
    const rows = groupCallsByRoute([payment]);
    expect(rows).toEqual([{ call: payment, depth: 0, childCount: 0, last: false }]);
  });

  it('does not nest calls from a different trace that reuse a span id', () => {
    const stray: ServerCall = { ...payment, spanId: 'up-3', traceId: 'trace-2' };
    expect(groupCallsByRoute([route, stray]).every((row) => row.depth === 0)).toBe(true);
  });

  it('finds the parent route and the children of a route', () => {
    const all = [route, customer, payment, earlier];
    expect(relatedServerCalls(payment, all)).toEqual({ parent: route, children: [] });
    expect(relatedServerCalls(route, all)).toEqual({ parent: null, children: [customer, payment] });
  });
});
