import { describe, expect, it } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import type { CapturedRequest, TraceSpan } from '@apilens/shared-types';
import { buildTraceTree } from '@apilens/trace-engine';
import {
  analysePerformance,
  detectDuplicateRequests,
  detectExcessiveCalls,
  detectFailedDownstream,
  detectInconsistentResponses,
  detectLargeResponses,
  detectRetryLoops,
  detectSequentialWaterfalls,
  detectSlowDownstream,
  detectSlowRequests,
} from '../performance';
import { analyseErrors, classifyError, explainFailure } from '../errors';
import { buildCatalog, suggestScenarios, suggestScenariosForSession } from '../catalog';
import { computeSessionStats } from '../session-stats';

function req(url: string, startedAt: number, durationMs: number, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({ sessionId: 's', url, method: 'GET', channel: 'page-hook', startedAt }),
    statusCode: 200,
    timing: { startedAt, completedAt: startedAt + durationMs, durationMs, injectedDelayMs: null },
    ...overrides,
  };
}

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    spanId: 'aaaaaaaaaaaaaaa1',
    traceId: 'tttttttttttttttttttttttttttttttt',
    parentSpanId: null,
    sessionId: 's',
    serviceName: 'checkout-js',
    operationName: 'POST /checkout',
    kind: 'server',
    source: 'bff',
    channel: 'server-sdk',
    method: 'POST',
    url: '/checkout',
    statusCode: 200,
    status: 'ok',
    startedAt: 0,
    endedAt: 100,
    durationMs: 100,
    attributes: {},
    events: [],
    error: null,
    mockedBy: null,
    ...overrides,
  };
}

describe('duplicate and volume detection', () => {
  it('flags the same endpoint called repeatedly in a short window', () => {
    const requests = [0, 200, 400, 600, 800].map((offset) => req('https://a.com/api/customer', offset, 10));
    const insights = detectDuplicateRequests(requests);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.observed).toContain('5 times');
    expect(insights[0]!.requestIds).toHaveLength(5);
  });

  it('does not flag spaced-out calls', () => {
    const requests = [0, 10_000, 20_000].map((offset) => req('https://a.com/api/customer', offset, 10));
    expect(detectDuplicateRequests(requests)).toHaveLength(0);
  });

  it('groups by path template so ids do not fragment the count', () => {
    const requests = [0, 100, 200].map((offset, index) => req(`https://a.com/api/orders/${index}`, offset, 10));
    expect(detectDuplicateRequests(requests)).toHaveLength(1);
  });

  it('flags high overall call volume', () => {
    const requests = Array.from({ length: 8 }, (_, index) => req('https://a.com/api/customer', index * 10_000, 10));
    expect(detectExcessiveCalls(requests)).toHaveLength(1);
  });

  it('ignores static assets', () => {
    const requests = [0, 100, 200].map((offset) => req('https://a.com/app.js', offset, 10, { type: 'static' }));
    expect(detectDuplicateRequests(requests)).toHaveLength(0);
  });
});

describe('latency and payload detection', () => {
  it('flags slow requests and escalates severity', () => {
    const insights = detectSlowRequests([req('https://a.com/api/order', 0, 4_000)]);
    expect(insights[0]!.severity).toBe('critical');
    expect(insights[0]!.metrics.durationMs).toBe(4_000);
  });

  it('attributes an injected delay to the mock rule', () => {
    const insights = detectSlowRequests([
      req('https://a.com/api/order', 0, 5_000, {
        mock: { ruleId: 'r', ruleName: 'Slow order', scenarioId: null, transport: 'page-hook', failureType: 'slow-response', appliedAt: 0 },
      }),
    ]);
    expect(insights[0]!.possibleCause).toContain('ApiLens mock rule');
  });

  it('flags oversized responses', () => {
    const large = req('https://a.com/api/list', 0, 10, {
      responseBody: { encoding: 'utf8', content: 'x', byteLength: 4 * 1024 * 1024, mimeType: 'application/json', omittedReason: null },
    });
    expect(detectLargeResponses([large])[0]!.metrics.bytes).toBe(4 * 1024 * 1024);
  });

  it('flags sequential chains that could run in parallel', () => {
    const requests = [req('https://a.com/a', 0, 100), req('https://a.com/b', 105, 100), req('https://a.com/c', 210, 100)];
    const insights = detectSequentialWaterfalls(requests);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.metrics.calls).toBe(3);
    expect(Number(insights[0]!.metrics.parallelMs)).toBeLessThan(Number(insights[0]!.metrics.sequentialMs));
  });

  it('does not flag two overlapping calls as sequential', () => {
    expect(detectSequentialWaterfalls([req('https://a.com/a', 0, 100), req('https://a.com/b', 10, 100)])).toHaveLength(0);
  });
});

describe('retry and consistency detection', () => {
  it('flags a retry chain that never recovered', () => {
    const insights = detectRetryLoops([
      req('https://a.com/api/pay', 0, 10, { statusCode: 503 }),
      req('https://a.com/api/pay', 100, 10, { statusCode: 503, retryAttempt: 1, retryOf: 'x' }),
      req('https://a.com/api/pay', 200, 10, { statusCode: 503, retryAttempt: 2, retryOf: 'y' }),
    ]);
    expect(insights[0]!.severity).toBe('critical');
    expect(insights[0]!.metrics.recovered).toBe('no');
  });

  it('downgrades a recovered retry chain to info', () => {
    const insights = detectRetryLoops([req('https://a.com/api/pay', 100, 10, { statusCode: 200, retryAttempt: 1, retryOf: 'x' })]);
    expect(insights[0]!.severity).toBe('info');
  });

  it('flags the same GET returning different bodies quickly', () => {
    const insights = detectInconsistentResponses([
      req('https://a.com/api/cart', 0, 10, { responseBody: makeBody('{"total":10}', 'application/json') }),
      req('https://a.com/api/cart', 500, 10, { responseBody: makeBody('{"total":20}', 'application/json') }),
    ]);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.kind).toBe('inconsistent-response');
  });
});

describe('trace-based detection', () => {
  const root = span({ spanId: 'root000000000001', startedAt: 0, endedAt: 3_800, durationMs: 3_800 });
  const slowChild = span({ spanId: 'child00000000001', parentSpanId: 'root000000000001', serviceName: 'order-service', startedAt: 100, endedAt: 3_600, durationMs: 3_500 });

  it('attributes a slow trace to the dominant downstream span', () => {
    const tree = buildTraceTree([root, slowChild])!;
    const insights = detectSlowDownstream([tree]);
    expect(insights[0]!.metrics.service).toBe('order-service');
    expect(Number(insights[0]!.metrics.sharePercent)).toBeGreaterThan(70);
  });

  it('does not attribute when no single span dominates', () => {
    const a = span({ spanId: 'a000000000000001', parentSpanId: 'root000000000001', startedAt: 0, endedAt: 1_200, durationMs: 1_200 });
    const b = span({ spanId: 'b000000000000001', parentSpanId: 'root000000000001', startedAt: 1_200, endedAt: 2_400, durationMs: 1_200 });
    expect(detectSlowDownstream([buildTraceTree([root, a, b])!])).toHaveLength(0);
  });

  it('identifies the deepest failing service', () => {
    const failing = span({ spanId: 'deep000000000001', parentSpanId: 'child00000000001', serviceName: 'vesta', status: 'error', statusCode: 503 });
    const insights = detectFailedDownstream([buildTraceTree([root, slowChild, failing])!]);
    expect(insights[0]!.metrics.deepestService).toBe('vesta');
    expect(insights[0]!.severity).toBe('critical');
  });
});

describe('error classification', () => {
  it('maps status codes to categories', () => {
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 401 }))).toBe('authentication');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 403 }))).toBe('authorization');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 429 }))).toBe('rate-limit');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 504 }))).toBe('timeout');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 500 }))).toBe('server-error');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 404 }))).toBe('client-error');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: 200 }))).toBeNull();
  });

  it('maps transport errors to network categories', () => {
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: null, error: 'net::ERR_CONNECTION_RESET' }))).toBe('network-error');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: null, error: 'TimedOut' }))).toBe('timeout');
    expect(classifyError(req('https://a.com/x', 0, 1, { statusCode: null, error: 'Blocked by CORS policy' }))).toBe('cors');
  });

  it('flags a 200 with unparsable JSON', () => {
    const broken = req('https://a.com/x', 0, 1, { statusCode: 200, responseBody: makeBody('{"a":', 'application/json') });
    expect(classifyError(broken)).toBe('invalid-json');
  });

  it('groups errors by category and endpoint', () => {
    const report = analyseErrors([
      req('https://a.com/api/pay', 0, 1, { statusCode: 500 }),
      req('https://a.com/api/pay', 10, 1, { statusCode: 500 }),
      req('https://a.com/api/customer', 20, 1, { statusCode: 401 }),
    ]);
    expect(report.totalErrors).toBe(3);
    expect(report.groups[0]!.count).toBe(2);
  });

  it('attributes failures to the deepest failing span when telemetry exists', () => {
    const failing = span({ spanId: 'deep000000000001', parentSpanId: 'root000000000001', serviceName: 'vesta', status: 'error', statusCode: 503 });
    const tree = buildTraceTree([span({ spanId: 'root000000000001', status: 'error', statusCode: 500 }), failing])!;
    const report = analyseErrors([req('https://a.com/api/pay', 0, 1, { statusCode: 500, traceId: tree.traceId })], { trees: [tree] });
    expect(report.groups[0]!.likelyFailureSource).toMatchObject({ service: 'vesta', confidence: 'observed' });
  });

  it('states honestly when there is no server telemetry', () => {
    const report = analyseErrors([req('https://a.com/api/pay', 0, 1, { statusCode: 500 })]);
    expect(report.groups[0]!.likelyFailureSource).toBeNull();
  });

  it('separates observed facts from possible causes', () => {
    const failure = req('https://a.com/api/pay', 0, 1, { statusCode: 401 });
    const context = explainFailure(failure, [failure], []);
    expect(context.observed.some((line) => line.includes('401'))).toBe(true);
    expect(context.possibleCauses.length).toBeGreaterThan(0);
  });

  it('labels simulated failures explicitly', () => {
    const mocked = req('https://a.com/api/pay', 0, 1, {
      statusCode: 500,
      mock: { ruleId: 'r', ruleName: 'Payment failure', scenarioId: null, transport: 'page-hook', failureType: 'status-code', appliedAt: 0 },
    });
    expect(explainFailure(mocked, [mocked]).observed.some((line) => line.includes('simulated'))).toBe(true);
  });
});

describe('catalog and scenario suggestions', () => {
  it('builds a catalog keyed by path template', () => {
    const catalog = buildCatalog([
      req('https://a.com/api/orders/1', 0, 100),
      req('https://a.com/api/orders/2', 10, 200),
      req('https://a.com/api/customer', 20, 50),
    ]);
    const orders = catalog.entries.find((entry) => entry.pathTemplate === '/api/orders/{id}')!;
    expect(orders.observedCount).toBe(2);
    expect(orders.averageDurationMs).toBe(150);
  });

  it('merges into an existing catalog', () => {
    const first = buildCatalog([req('https://a.com/api/orders/1', 0, 100)]);
    const merged = buildCatalog([req('https://a.com/api/orders/2', 10, 300)], first.entries);
    expect(merged.entries[0]!.observedCount).toBe(2);
    expect(merged.entries[0]!.averageDurationMs).toBe(200);
  });

  it('suggests the standard negative scenarios', () => {
    const set = suggestScenarios([req('https://a.com/api/payment', 0, 10, { method: 'POST', requestHeaders: { authorization: 'Bearer x' } })])!;
    const titles = set.suggestions.map((item) => item.title);
    expect(titles).toContain('500 Internal Server Error');
    expect(titles).toContain('401 Expired authentication');
    expect(titles).toContain('429 Rate limited');
    expect(titles).toContain('Request timeout');
  });

  it('omits auth scenarios when no credential is used', () => {
    const set = suggestScenarios([req('https://a.com/api/public', 0, 10)])!;
    expect(set.suggestions.map((item) => item.title)).not.toContain('401 Expired authentication');
  });

  it('marks transport failures as requiring care', () => {
    const set = suggestScenarios([req('https://a.com/api/x', 0, 10)])!;
    expect(set.suggestions.find((item) => item.title === 'Request timeout')?.risk).toBe('requires-care');
  });

  it('produces a suggestion set per endpoint', () => {
    expect(suggestScenariosForSession([req('https://a.com/api/a', 0, 1), req('https://a.com/api/b', 1, 1)])).toHaveLength(2);
  });
});

describe('reports', () => {
  it('computes percentiles, hosts and totals', () => {
    const report = analysePerformance([
      req('https://a.com/api/a', 0, 100),
      req('https://a.com/api/b', 10, 300),
      req('https://b.com/api/c', 20, 900),
    ]);
    expect(report.totalRequests).toBe(3);
    expect(report.averageDurationMs).toBeCloseTo(433.33, 1);
    expect(report.byHost[0]!.hostname).toBe('b.com');
    expect(report.slowest[0]!.durationMs).toBe(900);
  });

  it('ranks critical insights first', () => {
    const report = analysePerformance([
      req('https://a.com/api/slow', 0, 5_000),
      req('https://a.com/api/pay', 10, 10, { statusCode: 503, retryAttempt: 1, retryOf: 'x' }),
    ]);
    expect(report.insights[0]!.severity).toBe('critical');
  });

  it('computes session dashboard statistics', () => {
    const stats = computeSessionStats(
      [
        req('https://a.com/api/a', 0, 100, { pageUrl: 'https://a.com/checkout' }),
        req('https://a.com/api/b', 10, 300, { statusCode: 500, pageUrl: 'https://a.com/checkout' }),
        req('https://a.com/api/c', 20, 50, {
          channel: 'server-sdk',
          mock: { ruleId: 'r', ruleName: 'm', scenarioId: null, transport: 'server-sdk', failureType: 'status-code', appliedAt: 0 },
        }),
      ],
      [],
      0,
      1_000,
    );
    expect(stats.requestCount).toBe(3);
    expect(stats.failedCount).toBe(1);
    expect(stats.mockedCount).toBe(1);
    expect(stats.serverSideCount).toBe(1);
    expect(stats.statusBuckets['5xx']).toBe(1);
    expect(stats.pageCount).toBe(1);
    expect(stats.durationMs).toBe(1_000);
  });
});
