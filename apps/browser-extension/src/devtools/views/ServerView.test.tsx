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
  it('renders captured calls with connection and capture readiness', () => {
    const html = renderToStaticMarkup(<ServerView data={data()} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('Server API calls');
    expect(html).toContain('clear-app-bff');
    expect(html).toContain('/v2/billing');
    expect(html).toContain('Connected');
  });

  it('tells the tester what to do when no server is configured', () => {
    const html = renderToStaticMarkup(
      <ServerView data={data({ status: { ...status, configured: false, connected: false, health: null } })} onSettings={noop} onCopy={noop} onNotice={noop} />,
    );
    expect(html).toContain('No instrumented server connected');
    expect(html).toContain('Open settings');
  });

  it('surfaces a sync failure instead of showing an empty list', () => {
    const html = renderToStaticMarkup(
      <ServerView data={data({ calls: [], error: 'Control token rejected by the server.' })} onSettings={noop} onCopy={noop} onNotice={noop} />,
    );
    expect(html).toContain('Server link problem');
    expect(html).toContain('Control token rejected');
  });

  it('warns when the server buffer rolled over between polls', () => {
    const html = renderToStaticMarkup(
      <ServerView data={data({ status: { ...status, gap: true } })} onSettings={noop} onCopy={noop} onNotice={noop} />,
    );
    expect(html).toContain('Older calls were dropped');
  });
});

describe('ServerView route grouping', () => {
  const route: ServerCall = { ...call, seq: 2, spanId: 'route-1', kind: 'server', method: 'GET', url: 'https://app.example.com/api/bill', origin: 'https://app.example.com', path: '/api/bill', startedAt: 5 };
  const child: ServerCall = { ...call, parentSpanId: 'route-1' };

  it('lists the route first and its upstream call under it with the upstream host', () => {
    const html = renderToStaticMarkup(<ServerView data={data({ calls: [child, route] })} onSettings={noop} onCopy={noop} onNotice={noop} />);
    expect(html).toContain('Group by page call');
    expect(html).toContain('1 backend call');
    expect(html).toContain('Simulate a problem');
    expect(html).toContain('upstream.example.com');
    expect(html.indexOf('/api/bill')).toBeLessThan(html.indexOf('/v2/billing'));
    expect(html).toContain('class="tree last"');
  });

  it('links an upstream call back to the route that made it', () => {
    const html = renderToStaticMarkup(
      <ServerCallDetail call={child} related={{ parent: route, children: [] }} onSelectRelated={noop} onClose={noop} onMock={noop} onCopy={noop} />,
    );
    expect(html).toContain('Made while answering this page call');
    expect(html).toContain('/api/bill');
  });
});

describe('ServerCallDetail', () => {
  it('shows the overview with redacted query values', () => {
    const html = renderToStaticMarkup(<ServerCallDetail call={call} onClose={noop} onMock={noop} onCopy={noop} />);
    expect(html).toContain('/v2/billing');
    expect(html).toContain('Server → backend');
    expect(html).toContain('The server called the backend upstream.example.com (POST /v2/billing) and got “200 · OK” in 250 ms.');
    expect(html).toContain('[REDACTED]');
    expect(html).toContain('Simulate a problem');
    expect(html).toContain('trace-1');
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
