import { describe, expect, it } from 'vitest';
import { groupCallsByRoute, normalizeControlUrl, relatedServerCalls, serverCallKindClass, serverCallKindLabel, serverCallLayer, serverCallService, serverCallTmf, serverRuleFromCall, type ServerCall } from './server-control';
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
    expect(relatedServerCalls(payment, all)).toEqual({ parent: route, children: [], middleware: null });
    expect(relatedServerCalls(route, all)).toEqual({ parent: null, children: [customer, payment], middleware: null });
  });

  it('nests the middleware run, and the calls it made, under the page it let through', () => {
    const run: ServerCall = { ...route, seq: 20, spanId: 'mw-run', traceId: 'trace-p', stage: 'middleware', path: '/myaccount/billing', startedAt: 90 };
    const session: ServerCall = { ...customer, seq: 21, spanId: 'mw-session', traceId: 'trace-p', parentSpanId: 'mw-run', stage: 'middleware', path: '/session', startedAt: 95 };
    const page: ServerCall = { ...route, seq: 22, spanId: 'page', traceId: 'trace-p', middlewareSpanId: 'mw-run', path: '/myaccount/billing', startedAt: 100 };
    const balance: ServerCall = { ...customer, seq: 23, spanId: 'balance', traceId: 'trace-p', parentSpanId: 'page', path: '/balance', startedAt: 110 };

    const rows = groupCallsByRoute([balance, session, page, run]);
    expect(rows.map((row) => [row.call.spanId, row.depth, row.childCount, row.last])).toEqual([
      ['page', 0, 3, false],
      ['mw-run', 1, 1, false],
      ['mw-session', 2, 0, true],
      ['balance', 1, 0, true],
    ]);
    expect(relatedServerCalls(page, [run, session, page, balance]).middleware).toBe(run);
    expect(relatedServerCalls(run, [run, session, page, balance]).parent).toBe(page);
  });

  it('keeps a middleware run that redirected (no page behind it) at the top', () => {
    const run: ServerCall = { ...route, seq: 30, spanId: 'mw-only', traceId: 'trace-r', stage: 'middleware', statusCode: 307 };
    const session: ServerCall = { ...customer, seq: 31, spanId: 'mw-s', traceId: 'trace-r', parentSpanId: 'mw-only', stage: 'middleware' };
    expect(groupCallsByRoute([run, session]).map((row) => [row.call.spanId, row.depth])).toEqual([['mw-only', 0], ['mw-s', 1]]);
  });
});

describe('calls seen by the ApiLens relay (BFF → JCS → TMF → OSB)', () => {
  const at = (start: number, end: number) => ({ startedAt: start, endedAt: end, durationMs: end - start });
  const page: ServerCall = { ...call, seq: 1, spanId: 'page', traceId: 'T', kind: 'server', path: '/orders/new', ...at(0, 900) };
  const jcs: ServerCall = { ...call, seq: 2, spanId: 'jcs', traceId: 'T', parentSpanId: 'page', path: '/jcs/orders', ...at(10, 880) };
  // The relay records JCS's own span as the parent, which ApiLens never sees.
  const tmf622: ServerCall = { ...call, seq: 3, spanId: 'tmf622', traceId: 'T', parentSpanId: 'jcs-internal-1', serviceName: 'jcs', layer: 'tmf622', path: '/productOrder', ...at(40, 600) };
  const tmf629: ServerCall = { ...call, seq: 4, spanId: 'tmf629', traceId: 'T', parentSpanId: 'jcs-internal-2', serviceName: 'jcs', layer: 'tmf629', path: '/customer/1', ...at(45, 120) };
  const osb: ServerCall = { ...call, seq: 5, spanId: 'osb', traceId: 'T', parentSpanId: 'tmf622-internal', serviceName: 'tmf622', layer: 'osb', path: '/osb/order', ...at(100, 500) };

  it('nests each hop under the call that made it', () => {
    const rows = groupCallsByRoute([osb, tmf629, tmf622, jcs, page]);
    expect(rows.map((row) => [row.call.spanId, row.depth, row.childCount, row.last])).toEqual([
      ['page', 0, 4, false],
      ['jcs', 1, 2, true],
      ['tmf622', 2, 1, false],
      ['osb', 3, 0, true],
      ['tmf629', 2, 0, true],
    ]);
  });

  it('tolerates a small clock difference between the app and the relay host', () => {
    const early: ServerCall = { ...tmf629, ...at(5, 885) };
    expect(groupCallsByRoute([page, jcs, early]).find((row) => row.call.spanId === 'tmf629')?.depth).toBe(2);
  });

  it('keeps relay calls from another trace, or without one, at the top', () => {
    const elsewhere: ServerCall = { ...tmf629, traceId: 'OTHER' };
    expect(groupCallsByRoute([page, jcs, elsewhere]).find((row) => row.call.spanId === 'tmf629')?.depth).toBe(0);
  });

  it('nests under the BFF call directly when the backend forwards the trace without its own span', () => {
    const forwarded: ServerCall = { ...tmf629, parentSpanId: 'jcs', ...at(2_000, 2_100) };
    expect(relatedServerCalls(forwarded, [page, jcs, forwarded]).parent).toBe(jcs);
  });

  it('shows what a JCS call led to, and where a TMF call came from', () => {
    const all = [page, jcs, tmf622, tmf629, osb];
    expect(relatedServerCalls(jcs, all)).toMatchObject({ parent: page, children: [tmf622, tmf629] });
    expect(relatedServerCalls(osb, all)).toMatchObject({ parent: tmf622, children: [] });
  });

  it('labels a relay call by its route and scopes a mock made from it to the tester', () => {
    expect(serverCallKindLabel(tmf622)).toBe('TMF622');
    expect(serverCallKindClass(tmf622)).toBe('kind-layer');
    expect(serverCallKindClass(jcs)).toBe('kind-backend');
    const rule = serverRuleFromCall(tmf622);
    expect(rule.match).toMatchObject({ sessionId: 'qa-1', urlPattern: '*/productOrder', kind: 'client' });
    expect(rule.name).toBe('TMF622 POST /productOrder → 503');
    expect(serverRuleFromCall({ ...tmf622, sessionId: 'apilens-ambient' }).match.sessionId).toBeUndefined();
    expect(serverRuleFromCall(jcs).match.sessionId).toBeUndefined();
  });
});

describe('layers: a JCS call and the TMF calls it made', () => {
  const at = (start: number, end: number) => ({ startedAt: start, endedAt: end, durationMs: end - start });
  const svc = (host: string) => ({ origin: `http://${host}`, url: `http://${host}/x` });
  const page: ServerCall = { ...call, seq: 1, spanId: 'page', traceId: 'T', kind: 'server', path: '/myaccount/dashboard', ...at(0, 1_000) };
  // Two JCS calls in parallel; the longer one (records) also spans the TMF call's time window.
  const balance: ServerCall = { ...call, ...svc('bill-analysis-js.dxl-dev-ie.svc.cluster.local:8080'), seq: 2, spanId: 'balance', traceId: 'T', parentSpanId: 'page', path: '/billAnalysis/v1/balance', ...at(100, 500) };
  const records: ServerCall = { ...call, ...svc('records-js.dxl-dev-ie.svc.cluster.local:8080'), seq: 3, spanId: 'records', traceId: 'T', parentSpanId: 'page', path: '/journeyCustomerOverview/v1/customer', ...at(120, 900) };
  const bill: ServerCall = { ...call, seq: 4, spanId: 'tmf678', traceId: 'T', parentSpanId: 'dd-span', serviceName: 'bill-analysis-js', layer: 'tmf678', path: '/customerBill', ...at(150, 400) };

  it('puts a TMF call under the call to the JCS that made it, not a parallel one', () => {
    const rows = groupCallsByRoute([page, records, balance, bill]);
    expect(rows.find((row) => row.call.spanId === 'tmf678')).toMatchObject({ depth: 2 });
    const index = rows.findIndex((row) => row.call.spanId === 'tmf678');
    expect(rows[index - 1]!.call.spanId).toBe('balance');
  });

  it('names services and TMF APIs the way people do', () => {
    expect(serverCallService(balance)).toBe('bill-analysis-js');
    expect(serverCallService({ origin: 'https://upstream.example.com' })).toBe('upstream.example.com');
    expect(serverCallTmf(bill)).toEqual({ id: 'TMF678', name: 'Customer Bill' });
    expect(serverCallTmf({ ...call, path: '/tmf-api/accountManagement/v4/billingAccount' })).toEqual({ id: 'TMF666', name: 'Account' });
    expect(serverCallTmf({ ...bill, layer: 'osb' })).toEqual({ id: 'OSB', name: null });
    expect(serverCallTmf(balance)).toBeNull();
    expect([page, balance, bill].map((value) => serverCallLayer(value))).toEqual(['page', 'service', 'tmf']);
  });
});
