import { describe, expect, it } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import type { CapturedRequest, EvidenceEnvironmentInfo, QaSession, Rule, TraceSpan } from '@apilens/shared-types';
import { DEFAULT_REDACTION_POLICY } from '@apilens/security';
import { buildEvidenceBundle, renderArtifacts } from '../bundle';
import { toHar } from '../har';
import { toMarkdown } from '../markdown';
import { toHtml } from '../html';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const session: QaSession = {
  id: 'sess-1',
  name: 'Checkout Failure Test',
  status: 'stopped',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_161_000,
  environmentId: 'qa',
  startUrl: 'https://shop.qa.example.com/checkout',
  userAgent: 'Mozilla/5.0',
  activeRuleIds: ['rule-1'],
  markers: [],
  tags: [],
  notes: '',
};

const environment: EvidenceEnvironmentInfo = {
  environmentId: 'qa',
  environmentName: 'QA',
  browser: 'Chrome 120',
  userAgent: 'Mozilla/5.0',
  platform: 'Windows',
  extensionVersion: '1.0.0',
  agentVersion: '1.0.0',
};

const rule: Rule = {
  id: 'rule-1',
  scenarioId: null,
  name: 'Payment failure',
  description: '',
  enabled: true,
  priority: 10,
  conditions: [{ field: 'url', operator: 'contains', value: '/payment' }],
  conditionLogic: 'and',
  action: { type: 'status-code', statusCode: 500 },
  applyMode: 'always',
  appliedCount: 1,
  environments: ['qa'],
  createdAt: 0,
  updatedAt: 0,
};

function req(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({
      sessionId: 'sess-1',
      url: 'https://shop.qa.example.com/api/payment',
      method: 'POST',
      channel: 'page-hook',
      startedAt: 1_700_000_010_000,
    }),
    statusCode: 200,
    timing: { startedAt: 1_700_000_010_000, completedAt: 1_700_000_010_120, durationMs: 120, injectedDelayMs: null },
    requestHeaders: { 'content-type': 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: makeBody('{"amount":20}', 'application/json'),
    responseBody: makeBody('{"status":"OK"}', 'application/json'),
    pageUrl: 'https://shop.qa.example.com/checkout',
    ...overrides,
  };
}

const failing = req({
  id: 'r-fail',
  statusCode: 500,
  traceId: TRACE_ID,
  spanId: '00f067aa0ba902b7',
  responseBody: makeBody('{"code":"PAYMENT_FAILED"}', 'application/json'),
  mock: { ruleId: 'rule-1', ruleName: 'Payment failure', scenarioId: null, transport: 'page-hook', failureType: 'status-code', appliedAt: 0 },
});

const serverSpan: TraceSpan = {
  spanId: 'aaaaaaaaaaaaaaa1',
  traceId: TRACE_ID,
  parentSpanId: '00f067aa0ba902b7',
  sessionId: 'sess-1',
  serviceName: 'payment-service',
  operationName: 'POST /charge',
  kind: 'server',
  source: 'internal-service',
  channel: 'server-sdk',
  method: 'POST',
  url: '/charge',
  statusCode: 503,
  status: 'error',
  startedAt: 1_700_000_010_010,
  endedAt: 1_700_000_010_110,
  durationMs: 100,
  attributes: {},
  events: [],
  error: 'HTTP 503',
  mockedBy: null,
};

function build(overrides: Partial<Parameters<typeof buildEvidenceBundle>[0]> = {}) {
  return buildEvidenceBundle({
    session,
    requests: [req(), failing],
    spans: [serverSpan],
    rules: [rule],
    environment,
    redactionPolicy: DEFAULT_REDACTION_POLICY,
    consoleMessages: [{ level: 'error', text: 'Payment unsuccessful', timestamp: 1, url: null }],
    ...overrides,
  });
}

describe('evidence bundle', () => {
  it('assembles stats, traces, errors and insights', () => {
    const bundle = build();
    expect(bundle.stats.requestCount).toBe(2);
    expect(bundle.stats.failedCount).toBe(1);
    expect(bundle.stats.mockedCount).toBe(1);
    expect(bundle.traces.length).toBeGreaterThan(0);
    expect(bundle.errors.totalErrors).toBe(1);
    expect(bundle.appliedRules).toHaveLength(1);
  });

  it('attributes the failure to the deepest failing service', () => {
    const bundle = build();
    expect(bundle.errors.groups[0]!.likelyFailureSource?.service).toBe('payment-service');
  });

  it('redacts sensitive data before export', () => {
    const bundle = build({
      requests: [req({ requestHeaders: { authorization: 'Bearer super-secret-token' } })],
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('super-secret-token');
    expect(bundle.containsUnmaskedSecrets).toBe(false);
  });

  it('flags an export that deliberately disabled redaction', () => {
    const bundle = build({
      requests: [req({ requestHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } })],
      options: { disableRedaction: true },
    });
    expect(bundle.containsUnmaskedSecrets).toBe(true);
  });

  it('omits bodies when asked', () => {
    const bundle = build({ options: { includeBodies: false } });
    expect(bundle.requests[0]!.responseBody?.content).toBeNull();
    expect(bundle.requests[0]!.responseBody?.omittedReason).toContain('excluded');
  });

  it('excludes static assets by default', () => {
    const bundle = build({ requests: [req(), req({ id: 'static', url: 'https://shop.qa.example.com/app.js', type: 'static' })] });
    expect(bundle.requests).toHaveLength(1);
  });
});

describe('HAR export', () => {
  it('produces a valid HAR 1.2 document', () => {
    const har = JSON.parse(toHar(build(), false)) as {
      log: { version: string; entries: Array<{ request: { method: string }; response: { status: number }; timings: { wait: number } }> };
    };
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(2);
    expect(har.log.entries[0]!.request.method).toBe('POST');
    expect(har.log.entries[1]!.response.status).toBe(500);
    expect(har.log.entries[0]!.timings.wait).toBe(120);
  });

  it('records provenance in entry comments', () => {
    const har = JSON.parse(toHar(build(), false)) as { log: { entries: Array<{ comment: string }> } };
    expect(har.log.entries[1]!.comment).toContain('apilens.mocked_by=Payment failure');
    expect(har.log.entries[1]!.comment).toContain('apilens.channel=page-hook');
  });

  it('states the masking status in the log comment', () => {
    expect(JSON.parse(toHar(build(), false)).log.comment).toContain('masked');
  });
});

describe('Markdown export', () => {
  const markdown = toMarkdown(build());

  it('includes the QA context and summary', () => {
    expect(markdown).toContain('# Checkout Failure Test');
    expect(markdown).toContain('| Environment | QA |');
    expect(markdown).toContain('| Requests | 2 |');
  });

  it('documents mock configuration and failures', () => {
    expect(markdown).toContain('## Mock configuration');
    expect(markdown).toContain('Payment failure');
    expect(markdown).toContain('## Failed APIs');
  });

  it('renders the trace tree', () => {
    expect(markdown).toContain('## API traces');
    expect(markdown).toContain('payment-service');
  });

  it('includes console errors', () => {
    expect(markdown).toContain('Payment unsuccessful');
  });

  it('warns loudly when redaction was disabled', () => {
    const unmasked = toMarkdown(
      build({
        requests: [req({ requestHeaders: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } })],
        options: { disableRedaction: true },
      }),
    );
    expect(unmasked).toContain('WARNING');
  });

  it('groups scenario results and screenshot labels', () => {
    const scenarioMarkdown = toMarkdown(build({ session: {
      ...session,
      scenarios: [{ id: 'sc-1', title: 'Active user state', expectedResult: 'Allowance is visible', actualResult: '23GB displayed', status: 'passed', startedAt: session.startedAt, endedAt: session.endedAt, notes: '' }],
      markers: [{ id: 'shot-1', kind: 'screenshot', label: 'Desktop plan view', timestamp: session.startedAt, detail: session.startUrl, resourceRef: 'data:image/png;base64,AAAA', scenarioId: 'sc-1' }],
    } }));
    expect(scenarioMarkdown).toContain('## Scenario evidence');
    expect(scenarioMarkdown).toContain('Active user state');
    expect(scenarioMarkdown).toContain('Desktop plan view');
  });
});

describe('HTML export', () => {
  const html = toHtml(build());

  it('is a self-contained document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src="http');
  });

  it('escapes user-controlled content', () => {
    const injected = toHtml(build({ session: { ...session, name: '<img src=x onerror=alert(1)>' } }));
    expect(injected).not.toContain('<img src=x');
    expect(injected).toContain('&lt;img src=x');
  });

  it('renders the dashboard, failures and traces', () => {
    expect(html).toContain('Session summary');
    expect(html).toContain('Failed APIs');
    expect(html).toContain('payment-service');
  });

  it('renders safe screenshot evidence inside a Clear Mobile scenario section', () => {
    const scenarioHtml = toHtml(build({ session: {
      ...session,
      scenarios: [{ id: 'sc-1', title: 'Error state', expectedResult: 'Error banner is shown', actualResult: 'Banner shown', status: 'passed', startedAt: session.startedAt, endedAt: session.endedAt, notes: '' }],
      markers: [
        { id: 'safe', kind: 'screenshot', label: 'Error banner', timestamp: session.startedAt, detail: session.startUrl, resourceRef: 'data:image/png;base64,AAAA', scenarioId: 'sc-1' },
        { id: 'unsafe', kind: 'screenshot', label: 'Unsafe', timestamp: session.startedAt, detail: null, resourceRef: 'javascript:alert(1)', scenarioId: 'sc-1' },
      ],
    } }));
    expect(scenarioHtml).toContain('Clear Mobile <em>Test Evidence</em>');
    expect(scenarioHtml).toContain('Scenario evidence');
    expect(scenarioHtml).toContain('data:image/png;base64,AAAA');
    expect(scenarioHtml).not.toContain('javascript:alert');
  });
});

describe('artifact rendering', () => {
  it('renders every requested format with sensible file names', () => {
    const artifacts = renderArtifacts(build(), { formats: ['json', 'har', 'markdown', 'html'] });
    expect(artifacts.map((artifact) => artifact.fileName)).toEqual([
      'checkout-failure-test.json',
      'checkout-failure-test.har',
      'checkout-failure-test.md',
      'checkout-failure-test.html',
    ]);
    expect(artifacts.every((artifact) => artifact.content.length > 0)).toBe(true);
  });

  it('renders only the requested subset', () => {
    expect(renderArtifacts(build(), { formats: ['har'] })).toHaveLength(1);
  });

  it('produces a parsable JSON artifact', () => {
    const json = renderArtifacts(build(), { formats: ['json'] })[0]!;
    expect(() => JSON.parse(json.content)).not.toThrow();
  });
});
