import { describe, expect, it } from 'vitest';
import { createCapturedRequest } from '@apilens/core';
import type { CapturedRequest, TraceSpan } from '@apilens/shared-types';
import { extractTraceContext, formatTraceparent, parseB3, parseTraceparent } from '../headers';
import { correlate, detectRetries, enrichWithTraceContext, groupRequestsByTrace } from '../correlator';
import { buildTraceTree, buildTraceTrees, buildWaterfall, findDeepestFailure, findParallelSpans, flattenTree } from '../tree';
import { buildDependencyGraph, toMermaid } from '../dependency-graph';
import { isSyntheticTrace, requestToSpan } from '../span-mapper';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

function req(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({
      sessionId: 's1',
      url: 'https://api.example.com/checkout',
      method: 'POST',
      channel: 'page-hook',
      originId: 'tab-1',
      startedAt: 1_000,
    }),
    ...overrides,
  };
}

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    spanId: SPAN_ID,
    traceId: TRACE_ID,
    parentSpanId: null,
    sessionId: 's1',
    serviceName: 'bff',
    operationName: 'POST /checkout',
    kind: 'server',
    source: 'bff',
    channel: 'server-sdk',
    method: 'POST',
    url: '/checkout',
    statusCode: 200,
    status: 'ok',
    startedAt: 1_000,
    endedAt: 1_100,
    durationMs: 100,
    attributes: {},
    events: [],
    error: null,
    mockedBy: null,
    ...overrides,
  };
}

describe('trace headers', () => {
  it('parses a valid traceparent', () => {
    const parsed = parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(parsed).toEqual({ version: '00', traceId: TRACE_ID, spanId: SPAN_ID, sampled: true });
  });

  it('rejects malformed and all-zero traceparents', () => {
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${SPAN_ID}-01`)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('round-trips the format helper', () => {
    expect(parseTraceparent(formatTraceparent(TRACE_ID, SPAN_ID, false))?.sampled).toBe(false);
  });

  it('parses single and multi-header B3', () => {
    expect(parseB3({ b3: `${TRACE_ID}-${SPAN_ID}-1` })?.traceId).toBe(TRACE_ID);
    expect(parseB3({ 'x-b3-traceid': TRACE_ID, 'x-b3-spanid': SPAN_ID, 'x-b3-parentspanid': 'aaaaaaaaaaaaaaaa' })?.parentSpanId).toBe(
      'aaaaaaaaaaaaaaaa',
    );
    expect(parseB3({ b3: '0' })).toBeNull();
    expect(parseB3({})).toBeNull();
  });

  it('prefers traceparent over B3 and reports its origin', () => {
    const context = extractTraceContext({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, 'x-b3-traceid': 'ffff', 'x-b3-spanid': 'eeee' });
    expect(context?.traceId).toBe(TRACE_ID);
    expect(context?.derivedFrom).toBe('traceparent');
  });

  it('falls back to correlation headers', () => {
    const context = extractTraceContext({ 'x-correlation-id': 'abc-123' });
    expect(context?.traceId).toBe('abc-123');
    expect(context?.derivedFrom).toBe('x-correlation-id');
  });

  it('honours custom configured headers', () => {
    const context = extractTraceContext(
      { 'x-vf-trace': 'vf-1', 'x-vf-span': 'vf-span' },
      {},
      { traceIdHeaders: ['x-vf-trace'], spanIdHeaders: ['x-vf-span'], correlationIdHeaders: [], parentSpanIdHeaders: [] },
    );
    expect(context?.traceId).toBe('vf-1');
    expect(context?.spanId).toBe('vf-span');
  });

  it('returns null when nothing correlatable is present', () => {
    expect(extractTraceContext({ accept: 'application/json' })).toBeNull();
  });

  it('reads identity from response headers too', () => {
    expect(extractTraceContext({}, { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` })?.traceId).toBe(TRACE_ID);
  });
});

describe('span projection', () => {
  it('marks requests without propagation as synthetic', () => {
    const projected = requestToSpan(req());
    expect(isSyntheticTrace(projected)).toBe(true);
    expect(projected.traceId).toHaveLength(32);
  });

  it('keeps propagated identity when present', () => {
    const projected = requestToSpan(req({ traceId: TRACE_ID, spanId: SPAN_ID }));
    expect(projected.traceId).toBe(TRACE_ID);
    expect(isSyntheticTrace(projected)).toBe(false);
  });

  it('groups requests from the same user action under one synthetic trace', () => {
    const grouped = groupRequestsByTrace([
      req({ id: 'a', timing: { startedAt: 1_000, completedAt: 1_010, durationMs: 10, injectedDelayMs: null } }),
      req({ id: 'b', timing: { startedAt: 1_500, completedAt: 1_510, durationMs: 10, injectedDelayMs: null } }),
      req({ id: 'c', timing: { startedAt: 9_000, completedAt: 9_010, durationMs: 10, injectedDelayMs: null } }),
    ]);
    expect(grouped.size).toBe(2);
  });

  it('derives status from the response', () => {
    expect(requestToSpan(req({ statusCode: 500 })).status).toBe('error');
    expect(requestToSpan(req({ statusCode: 200 })).status).toBe('ok');
    expect(requestToSpan(req({ error: 'net::ERR' })).status).toBe('error');
  });
});

describe('enrichment and correlation', () => {
  it('lifts trace ids out of headers onto the request', () => {
    const enriched = enrichWithTraceContext(req({ requestHeaders: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` } }));
    expect(enriched.traceId).toBe(TRACE_ID);
    expect(enriched.spanId).toBe(SPAN_ID);
  });

  it('joins a browser request to server spans through traceparent', () => {
    const browser = req({ requestHeaders: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` } });
    const serverChild = span({ spanId: 'aaaaaaaaaaaaaaa1', parentSpanId: SPAN_ID, serviceName: 'payment-service' });
    const result = correlate([browser], [span(), serverChild]);
    const tree = buildTraceTree(result.spans, { requestIdBySpanId: result.requestIdBySpanId });

    expect(tree?.traceId).toBe(TRACE_ID);
    expect(tree?.spanCount).toBe(2);
    expect(tree?.services).toContain('payment-service');
  });

  it('joins through a correlation id when only that is echoed', () => {
    const browser = req({ requestHeaders: { 'x-correlation-id': 'corr-1' } });
    const serverSpan = span({ attributes: { 'apilens.correlation_id': 'corr-1' } });
    const result = correlate([browser], [serverSpan]);
    expect(result.traceIdByRequestId.get(browser.id)).toBe(TRACE_ID);
  });

  it('marks uncorrelated requests as synthetic', () => {
    const browser = req();
    const result = correlate([browser], []);
    expect(result.syntheticRequestIds.has(browser.id)).toBe(true);
  });
});

describe('retry detection', () => {
  it('chains repeated calls after a failure', () => {
    const first = req({ id: '1', statusCode: 503, timing: { startedAt: 0, completedAt: 10, durationMs: 10, injectedDelayMs: null } });
    const second = req({ id: '2', statusCode: 503, timing: { startedAt: 500, completedAt: 510, durationMs: 10, injectedDelayMs: null } });
    const third = req({ id: '3', statusCode: 200, timing: { startedAt: 900, completedAt: 910, durationMs: 10, injectedDelayMs: null } });

    const result = detectRetries([first, second, third]);
    expect(result.find((item) => item.id === '2')?.retryAttempt).toBe(1);
    expect(result.find((item) => item.id === '3')?.retryAttempt).toBe(2);
    expect(result.find((item) => item.id === '1')?.retryOf).toBeNull();
  });

  it('does not treat repeated successes as retries', () => {
    const result = detectRetries([
      req({ id: '1', statusCode: 200, timing: { startedAt: 0, completedAt: 5, durationMs: 5, injectedDelayMs: null } }),
      req({ id: '2', statusCode: 200, timing: { startedAt: 50, completedAt: 55, durationMs: 5, injectedDelayMs: null } }),
    ]);
    expect(result.every((item) => item.retryAttempt === 0)).toBe(true);
  });

  it('respects the retry window', () => {
    const result = detectRetries(
      [
        req({ id: '1', statusCode: 500, timing: { startedAt: 0, completedAt: 5, durationMs: 5, injectedDelayMs: null } }),
        req({ id: '2', statusCode: 500, timing: { startedAt: 100_000, completedAt: 100_005, durationMs: 5, injectedDelayMs: null } }),
      ],
      { windowMs: 1_000, minFailureStatus: 408 },
    );
    expect(result.find((item) => item.id === '2')?.retryAttempt).toBe(0);
  });
});

describe('trace tree', () => {
  const root = span({ spanId: 'root000000000001', parentSpanId: null, serviceName: 'checkout-js', startedAt: 0, endedAt: 1000, durationMs: 1000 });
  const customer = span({ spanId: 'child00000000001', parentSpanId: 'root000000000001', serviceName: 'customer-service', startedAt: 10, endedAt: 153, durationMs: 143 });
  const payment = span({ spanId: 'child00000000002', parentSpanId: 'root000000000001', serviceName: 'payment-service', startedAt: 160, endedAt: 589, durationMs: 429 });
  const order = span({
    spanId: 'child00000000003',
    parentSpanId: 'root000000000001',
    serviceName: 'order-service',
    startedAt: 600,
    endedAt: 990,
    durationMs: 390,
    statusCode: 500,
    status: 'error',
    error: 'HTTP 500',
  });

  it('builds parent/child structure with depth', () => {
    const tree = buildTraceTree([root, customer, payment, order])!;
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.children).toHaveLength(3);
    expect(tree.roots[0]!.children[0]!.depth).toBe(1);
    expect(tree.errorCount).toBe(1);
    expect(tree.services).toEqual(['checkout-js', 'customer-service', 'order-service', 'payment-service']);
  });

  it('computes self time excluding children', () => {
    const tree = buildTraceTree([root, customer, payment, order])!;
    // Children cover 10-153, 160-589, 600-990 = 143 + 429 + 390 = 962ms of the 1000ms root.
    expect(Math.round(tree.roots[0]!.selfDurationMs)).toBe(38);
  });

  it('surfaces orphans as roots and flags gaps', () => {
    const orphan = span({ spanId: 'orphan0000000001', parentSpanId: 'missing000000001' });
    const tree = buildTraceTree([root, orphan])!;
    expect(tree.hasGaps).toBe(true);
    expect(tree.roots.some((node) => node.orphaned)).toBe(true);
  });

  it('tolerates a self-referencing parent without hanging', () => {
    const cyclic = span({ spanId: 'aaaaaaaaaaaaaaa1', parentSpanId: 'aaaaaaaaaaaaaaa1' });
    const tree = buildTraceTree([cyclic])!;
    expect(tree.spanCount).toBe(1);
    expect(flattenTree(tree)).toHaveLength(1);
  });

  it('returns null for an empty span set', () => {
    expect(buildTraceTree([])).toBeNull();
  });

  it('splits multiple traces', () => {
    const other = span({ traceId: 'ffffffffffffffffffffffffffffffff', spanId: 'bbbbbbbbbbbbbbb1' });
    expect(buildTraceTrees([root, other])).toHaveLength(2);
  });

  it('locates the deepest failure', () => {
    const deepFailure = span({ spanId: 'deep000000000001', parentSpanId: 'child00000000003', serviceName: 'vesta', status: 'error', statusCode: 503 });
    const tree = buildTraceTree([root, order, deepFailure])!;
    expect(findDeepestFailure(tree)?.span.serviceName).toBe('vesta');
  });

  it('finds spans that overlap in time', () => {
    const parallelA = span({ spanId: 'para000000000001', parentSpanId: 'root000000000001', startedAt: 100, endedAt: 300, durationMs: 200 });
    const parallelB = span({ spanId: 'para000000000002', parentSpanId: 'root000000000001', startedAt: 150, endedAt: 350, durationMs: 200 });
    const tree = buildTraceTree([root, parallelA, parallelB])!;
    expect(findParallelSpans(tree, 'para000000000001').map((node) => node.span.spanId)).toContain('para000000000002');
  });

  it('lays out a waterfall within the trace window', () => {
    const tree = buildTraceTree([root, customer, payment, order])!;
    const waterfall = buildWaterfall(tree);
    expect(waterfall.rows).toHaveLength(4);
    waterfall.rows.forEach((row) => {
      expect(row.offsetRatio).toBeGreaterThanOrEqual(0);
      expect(row.offsetRatio + row.widthRatio).toBeLessThanOrEqual(1.0001);
    });
  });
});

describe('dependency graph', () => {
  it('derives edges only from real parentage', () => {
    const parent = span({ spanId: 'p000000000000001', serviceName: 'checkout-js' });
    const child = span({ spanId: 'c000000000000001', parentSpanId: 'p000000000000001', serviceName: 'payment-api', durationMs: 100 });
    const unrelated = span({ spanId: 'u000000000000001', serviceName: 'other-api' });

    const graph = buildDependencyGraph([parent, child, unrelated]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: 'checkout-js', to: 'payment-api', callCount: 1 });
    expect(graph.nodes.map((node) => node.service).sort()).toEqual(['checkout-js', 'other-api', 'payment-api']);
  });

  it('renders Mermaid output', () => {
    const parent = span({ spanId: 'p000000000000001', serviceName: 'checkout-js' });
    const child = span({ spanId: 'c000000000000001', parentSpanId: 'p000000000000001', serviceName: 'payment-api' });
    const mermaid = toMermaid(buildDependencyGraph([parent, child]));
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('s_checkout_js');
    expect(toMermaid({ nodes: [], edges: [] })).toContain('No trace evidence');
  });
});
