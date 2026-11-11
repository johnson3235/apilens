import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerBridge } from './server-bridge';
import type { ServerCall, ServerMockRule } from '../shared/server-control';

/**
 * Two app pods behind a round-robin load balancer, each with its own buffer,
 * seq counter and rules, speaking the 0.5 control protocol (`cursors`).
 */
class FakePod {
  calls: ServerCall[] = [];
  rules: ServerMockRule[] = [];
  private seq = 0;

  constructor(readonly processId: string, private readonly understandsCursors = true) {}

  add(path: string): void {
    this.seq += 1;
    this.calls.push({
      seq: this.seq, spanId: `${this.processId}-${this.seq}`, traceId: `t-${this.processId}-${this.seq}`, parentSpanId: null,
      sessionId: 'apilens-ambient', scenarioId: null, serviceName: 'clear-bff', kind: 'server', method: 'GET',
      url: `https://clear.example${path}`, origin: 'https://clear.example', path, query: {}, statusCode: 200, status: 'ok',
      startedAt: this.seq, endedAt: this.seq + 1, durationMs: 1, bodyDurationMs: null, requestHeaders: {}, responseHeaders: {},
      requestBody: null, responseBody: null, requestBodyOmitted: null, responseBodyOmitted: null, error: null, mockedBy: null,
    });
  }

  answer(url: URL, init?: RequestInit): unknown {
    const operation = url.pathname.split('/').pop();
    if (operation === '__apilens' || operation === 'health') {
      return {
        ok: true, protocolVersion: 2, sdkVersion: '0.5.0', serviceName: 'clear-bff', processId: this.processId, startedAt: 0,
        enabled: true, captureRequestBodies: true, captureResponseBodies: true, maxBodyBytes: 1, mockingEnabled: true,
        routeMocksEnabled: false, bufferedCalls: this.calls.length, latestSeq: this.seq, droppedCalls: 0, ruleCount: this.rules.length,
        activeRuleCount: 0, agentDelivery: { accepted: 0, dropped: 0, lastError: null },
      };
    }
    if (operation === 'calls' && init?.method === 'DELETE') {
      this.calls = [];
      return { cleared: true };
    }
    if (operation === 'calls') {
      const cursors = url.searchParams.get('cursors');
      let since = Number(url.searchParams.get('since') ?? 0);
      if (cursors !== null && this.understandsCursors) {
        since = Number(cursors.split(',').find((entry) => entry.startsWith(`${this.processId}:`))?.split(':')[1] ?? 0);
      }
      return { processId: this.processId, latestSeq: this.seq, calls: this.calls.filter((call) => call.seq > since), gap: false };
    }
    if (operation === 'rules' && init?.method === 'PUT') {
      this.rules = (JSON.parse(String(init.body)) as { rules: ServerMockRule[] }).rules;
    }
    return { processId: this.processId, rules: this.rules, revision: 'r' };
  }
}

let pods: FakePod[] = [];
let next = 0;

beforeEach(() => {
  next = 0;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const pod = pods[next % pods.length]!;
    next += 1;
    return new Response(JSON.stringify(pod.answer(new URL(input), init)), { headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function bridge(): ServerBridge {
  const created = new ServerBridge();
  created.configure({ enabled: true, url: 'https://clear.example', token: 'x'.repeat(32), pollIntervalMs: 1000, pollInBackground: false } as never);
  return created;
}

const rule = (id: string, updatedAt: number): ServerMockRule => ({
  id, name: id, description: '', enabled: true, priority: 1, match: { method: 'GET', urlPattern: '*', matchType: 'glob', kind: 'client' },
  action: { type: 'status-code', statusCode: 503 }, applyMode: 'always', appliedCount: 0, createdAt: updatedAt, updatedAt,
});

describe('ServerBridge behind a load balancer', () => {
  it('collects every pod’s calls and never wipes them when another pod answers', async () => {
    const a = new FakePod('pod-a');
    const b = new FakePod('pod-b');
    pods = [a, b];
    a.add('/billing');
    b.add('/usage');
    const link = bridge();

    for (let poll = 0; poll < 4; poll += 1) await link.sync();
    expect(link.snapshot().map((call) => call.path).sort()).toEqual(['/billing', '/usage']);

    a.add('/plans');
    b.add('/addons');
    for (let poll = 0; poll < 4; poll += 1) await link.sync();
    expect(link.snapshot()).toHaveLength(4);
    expect(link.status().pods?.map((pod) => pod.processId).sort()).toEqual(['pod-a', 'pod-b']);
  });

  it('does not re-read a pod after Clear, because seq keeps growing', async () => {
    const a = new FakePod('pod-a');
    pods = [a];
    a.add('/one');
    const link = bridge();
    await link.sync();
    await link.clear();
    await link.sync();
    expect(link.snapshot()).toHaveLength(0);
    a.add('/two');
    await link.sync();
    expect(link.snapshot().map((call) => call.path)).toEqual(['/two']);
  });

  it('carries a saved mock to the pod that did not receive the save', async () => {
    const a = new FakePod('pod-a');
    const b = new FakePod('pod-b');
    pods = [a, b];
    const link = bridge();
    await link.sync();
    await link.sync();
    await link.pushRules([rule('mock-1', Date.now())]);
    for (let poll = 0; poll < 3; poll += 1) await link.sync();
    expect(a.rules.map((item) => item.id)).toEqual(['mock-1']);
    expect(b.rules.map((item) => item.id)).toEqual(['mock-1']);
  });

  it('lets a later edit from another tester win instead of overwriting it', async () => {
    const a = new FakePod('pod-a');
    pods = [a];
    const link = bridge();
    await link.pushRules([rule('mine', Date.now() - 10_000)]);
    a.rules = [rule('theirs', Date.now() + 5_000)];
    await link.sync();
    await link.sync();
    expect(a.rules.map((item) => item.id)).toEqual(['theirs']);
    expect(link.serverRules().map((item) => item.id)).toEqual(['theirs']);
  });

  it('still reads an SDK older than 0.5 through `since`', async () => {
    const old = new FakePod('pod-old', false);
    pods = [old];
    old.add('/a');
    const link = bridge();
    await link.sync();
    old.add('/b');
    await link.sync();
    await link.sync();
    expect(link.snapshot().map((call) => call.path)).toEqual(['/a', '/b']);
  });
});
