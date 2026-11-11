import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServerView } from './ServerView';
import { ServerCallDetail } from '../components/ServerCallDetail';
import { BodyViewer } from '../components/BodyViewer';
import { ServerMockEditor } from '../components/ServerMockEditor';
import { serverRuleFromCall, type ServerBridgeStatus, type ServerCall } from '../../shared/server-control';
import type { ServerData } from '../hooks/useServerData';

const call: ServerCall = {
  seq: 1,
  spanId: 'span-1',
  traceId: 'trace-1',
  parentSpanId: null,
  sessionId: 'qa-1',
  scenarioId: null,
  serviceName: 'clear-app-bff',
  kind: 'client',
  method: 'POST',
  url: 'https://upstream.example.com/v2/billing',
  origin: 'https://upstream.example.com',
  path: '/v2/billing',
  query: { contactId: '3055861', token: '[REDACTED]' },
  statusCode: 200,
  status: 'ok',
  startedAt: 10,
  endedAt: 260,
  durationMs: 250,
  bodyDurationMs: 265,
  requestHeaders: { 'content-type': 'application/json', authorization: '[REDACTED]' },
  responseHeaders: { 'content-type': 'application/json' },
  requestBody: { content: '{"contactId":"3055861"}', encoding: 'utf8', contentType: 'application/json', byteLength: 23, truncated: false, redacted: false },
  responseBody: { content: '{"amountDue":42.5}', encoding: 'utf8', contentType: 'application/json', byteLength: 18, truncated: true, redacted: true },
  requestBodyOmitted: null,
  responseBodyOmitted: null,
  error: null,
  mockedBy: null,
};

const status: ServerBridgeStatus = {
  configured: true,
  connected: true,
  endpoint: 'https://clear-app-dev.example.com/api/__apilens',
  health: {
    ok: true,
    protocolVersion: 2,
    sdkVersion: '0.2.0',
    serviceName: 'clear-app-bff',
    processId: 'proc-1',
    startedAt: 0,
    enabled: true,
    captureRequestBodies: true,
    captureResponseBodies: true,
    maxBodyBytes: 131072,
    mockingEnabled: true,
    routeMocksEnabled: false,
    bufferedCalls: 1,
    latestSeq: 1,
    droppedCalls: 0,
    ruleCount: 0,
    activeRuleCount: 0,
    agentDelivery: { accepted: 0, dropped: 0, lastError: null },
  },
  error: null,
  lastSyncAt: Date.now(),
  gap: false,
  callCount: 1,
  ruleCount: 0,
  processId: 'proc-1',
};

const data = (overrides: Partial<ServerData> = {}): ServerData => ({
  calls: [call],
  status,
  rules: [],
  error: null,
  syncing: false,
  refresh: async () => undefined,
  clear: async () => undefined,
  saveRules: async () => undefined,
  ...overrides,
});

const noop = (): void => undefined;

describe('ServerView', () => {
  it('renders captured calls with the live connection', () => {
    const html = renderToStaticMarkup(<ServerView data={data()} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('Server calls');
    expect(html).toContain('Live · clear-app-bff');
    expect(html).toContain('/v2/billing');
    expect(html).toContain('Backend');
  });

  it('shows only this tester\'s session while recording, and explains an empty filter', () => {
    const other: ServerCall = { ...call, spanId: 'span-2', seq: 2, sessionId: 'apilens-ambient', path: '/v2/other-tester', url: 'https://upstream.example.com/v2/other-tester' };
    const mine = renderToStaticMarkup(<ServerView data={data({ calls: [call, other] })} sessionId="qa-1" onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(mine).toContain('My session');
    expect(mine).toContain('/v2/billing');
    expect(mine).not.toContain('/v2/other-tester');

    const untagged = renderToStaticMarkup(<ServerView data={data({ calls: [other] })} sessionId="qa-9" onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(untagged).toContain('None of the 1 server calls carry your session yet');
    expect(untagged).toContain('Show everyone');

    const notRecording = renderToStaticMarkup(<ServerView data={data({ calls: [call, other] })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(notRecording).not.toContain('My session');
    expect(notRecording).toContain('/v2/other-tester');
  });

  it('explains an empty list from the server’s own counters, with the fix to copy', () => {
    const health = {
      ...status.health!, sdkVersion: '0.5.0', bufferedBytes: 30 * 1024 * 1024, maxBufferBytes: 32 * 1024 * 1024,
      configIssues: [{ setting: 'agentToken', problem: 'Missing, so spans are not delivered to the local agent.' }],
      capture: {
        installed: true, installedBy: 'boot' as const, requestsSeen: 9, requestsRecorded: 0,
        skipped: { ignoredPath: 0, noSession: 0, originNotAllowed: 9, noBackendCall: 0 },
        lastRejectedOrigin: 'http://10.0.0.7:3000', learnedOrigins: [], backendCalls: 0, cacheHits: 0, middlewareRuns: 0, lastRequestAt: 1,
      },
    };
    const html = renderToStaticMarkup(<ServerView data={data({ calls: [], status: { ...status, health } })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('9 requests ignored: unknown app address');
    expect(html).toContain('allowedAppOrigins: [&#x27;http://10.0.0.7:3000&#x27;],');
    expect(html).toContain('agentToken is switched off');
    expect(html).toContain('Server memory for captures is nearly full');
    expect(html).toContain('Copy');
  });

  it('flags a problem in the header while calls are listed', () => {
    const html = renderToStaticMarkup(<ServerView data={data({ status: { ...status, gap: true } })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('Some calls were dropped');
    expect(html).toContain('/v2/billing');
  });

  it('tells the tester what to do when no server is configured', () => {
    const html = renderToStaticMarkup(
      <ServerView data={data({ status: { ...status, configured: false, connected: false, health: null } })} onSettings={noop} onCopy={noop} onNotice={noop} />,
    );
    expect(html).toContain('See what the app’s server does behind the page');
    expect(html).toContain('Link a server');
  });

  it('surfaces a sync failure instead of claiming capture is ready', () => {
    const html = renderToStaticMarkup(
      <ServerView data={data({ calls: [], error: 'Control token rejected by the server.' })} onSettings={noop} onCopy={noop} onNotice={noop} />,
    );
    expect(html).toContain('Can’t reach the server.');
    expect(html).toContain('Control token rejected');
    expect(html).not.toContain('Capture is ready');
  });

  it('counts failed, mocked and cached calls in the filter chips', () => {
    const failed: ServerCall = { ...call, spanId: 'f', seq: 3, statusCode: 503, status: 'error', mockedBy: 'billing down' };
    const cached: ServerCall = { ...call, spanId: 'c', seq: 4, cache: 'hit' };
    const html = renderToStaticMarkup(<ServerView data={data({ calls: [call, failed, cached] })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toMatch(/Failed <b>1<\/b>/);
    expect(html).toMatch(/Mocked <b>1<\/b>/);
    expect(html).toMatch(/Cached <b>1<\/b>/);
    expect(html).toContain('>Cache<');
  });
});

describe('ServerView page grouping', () => {
  const route: ServerCall = { ...call, seq: 2, spanId: 'route-1', kind: 'server', method: 'GET', url: 'https://app.example.com/api/bill', origin: 'https://app.example.com', path: '/api/bill', startedAt: 5 };
  const child: ServerCall = { ...call, parentSpanId: 'route-1' };

  it('lists the page first, its backend call under it, and what the page needed', () => {
    const html = renderToStaticMarkup(<ServerView data={data({ calls: [child, route] })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('By page');
    expect(html).toContain('1 backend');
    expect(html).toContain('upstream.example.com');
    expect(html.indexOf('/api/bill')).toBeLessThan(html.indexOf('/v2/billing'));
    expect(html).toContain('indent d1');
    expect(html).toContain('class="wf"');
  });

  it('nests the middleware run under the page it let through', () => {
    const run: ServerCall = { ...route, spanId: 'mw', seq: 5, stage: 'middleware', startedAt: 1, endedAt: 4 };
    const page: ServerCall = { ...route, middlewareSpanId: 'mw' };
    const html = renderToStaticMarkup(<ServerView data={data({ calls: [run, page, child] })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('>Middleware<');
    expect(html).toContain('indent d1');
    expect(html).toContain('1 backend · middleware');
  });

  it('links a backend call back to the page that made it', () => {
    const html = renderToStaticMarkup(
      <ServerCallDetail call={child} related={{ parent: route, children: [] }} onSelectRelated={noop} onClose={noop} onMock={noop} onCopy={noop} />,
    );
    expect(html).toContain('Part of');
    expect(html).toContain('/api/bill');
  });
});

describe('ServerCallDetail', () => {
  it('shows the overview with redacted query values', () => {
    const html = renderToStaticMarkup(<ServerCallDetail call={call} onClose={noop} onMock={noop} onCopy={noop} />);
    expect(html).toContain('/v2/billing');
    expect(html).toContain('upstream.example.com');
    expect(html).toContain('The server called the backend upstream.example.com (POST /v2/billing) and got “200 · OK” in 250 ms.');
    expect(html).toContain('[REDACTED]');
    expect(html).toContain('Simulate a problem');
    expect(html).toContain('trace-1');
  });

  it('says plainly when Next answered from its cache', () => {
    const html = renderToStaticMarkup(<ServerCallDetail call={{ ...call, cache: 'hit' }} onClose={noop} onMock={noop} onCopy={noop} />);
    expect(html).toContain('from its own cache: the backend was not called this time');
    expect(html).toContain('from cache');
  });

  it('keeps Simulate a problem off when the deployment forbids server mocks', () => {
    const html = renderToStaticMarkup(<ServerCallDetail call={call} onClose={noop} onMock={noop} onCopy={noop} mockingEnabled={false} />);
    expect(html).toMatch(/disabled=""[^>]*>.*Simulate a problem/);
  });
});

describe('BodyViewer', () => {
  it('flags truncated and redacted payloads', () => {
    const html = renderToStaticMarkup(<BodyViewer body={call.responseBody} omitted={null} label="Response" />);
    expect(html).toContain('truncated');
    expect(html).toContain('redacted');
    expect(html).toContain('amountDue');
  });

  it('explains why a payload is missing rather than rendering a blank panel', () => {
    const html = renderToStaticMarkup(
      <BodyViewer body={null} omitted="Not captured: application/pdf is treated as binary" label="Response" />,
    );
    expect(html).toContain('application/pdf');
  });

  it('falls back to an emptyHint when the SDK gave no reason', () => {
    const html = renderToStaticMarkup(<BodyViewer body={null} omitted={null} label="Request" emptyHint="GET requests usually carry no body." />);
    expect(html).toContain('GET requests usually carry no body.');
  });
});

describe('ServerMockEditor', () => {
  it('renders a rule pre-filled from a captured call', () => {
    const rule = serverRuleFromCall(call);
    const html = renderToStaticMarkup(
      <ServerMockEditor rule={rule} saving={false} onChange={noop} onSave={noop} onCancel={noop} />,
    );
    expect(html).toContain('*/v2/billing');
    expect(html).toContain('Save and turn on');
    expect(html).toContain('Save, keep off');
    expect(html).toContain('When the server makes');
    // The 503 scenario is pre-selected and explains what the tester should check.
    expect(html).toMatch(/aria-checked="true"[^>]*><strong>Service is down/);
    expect(html).toContain('What to check:');
    // It arrives off, and limited to one call because dev servers are shared.
    expect(rule.enabled).toBe(false);
    expect(html).toContain('>Off<');
    expect(rule.applyMode).toBe('once');
  });

  it('shows the mutation editor only for passthrough rules', () => {
    const rule = { ...serverRuleFromCall(call), action: { type: 'passthrough-mutate' as const, fieldMutations: [{ path: 'data.amountDue', operation: 'nullify' as const }] } };
    const html = renderToStaticMarkup(<ServerMockEditor rule={rule} saving={false} onChange={noop} onSave={noop} onCancel={noop} />);
    expect(html).toContain('Field mutations');
    expect(html).toContain('data.amountDue nullify');
  });
});
