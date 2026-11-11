import { afterEach, describe, expect, it } from 'vitest';
import http, { createServer, Server as HttpServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { ApiLensNextSDK, outgoingMatcher } from '../index';
import { CallBuffer } from '../buffer';
import { redactBody } from '../redaction';
import type { ControlCallsResponse, ControlHealth, ServerCall, ServerMockRule } from '../types';

/**
 * Covers the 0.4.0 changes made for the CLEAR-APP SDK review: a control plane
 * with no route file, outgoing ignores, background-call attribution, restorable
 * patches, a memory budget and wider redaction.
 */

const originalFetch = globalThis.fetch;
const originalRequest = http.request;
const originalEmit = HttpServer.prototype.emit;
const token = 'review-control-token-0123456789abcdef';
let sdk: ApiLensNextSDK | undefined;
const servers: Server[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function create(overrides: Partial<ConstructorParameters<typeof ApiLensNextSDK>[0]> = {}): ApiLensNextSDK {
  sdk = new ApiLensNextSDK({
    serviceName: 'clear-bff',
    enabled: true,
    reportToAgent: false,
    allowedAppOrigins: ['*'],
    captureWithoutSession: true,
    captureBodies: { request: true, response: true },
    control: { enabled: true, token },
    ...overrides,
  });
  sdk.install();
  return sdk;
}

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const startBackend = () => listen((req, res) => json(res, 200, { path: req.url, msisdn: '353871234567', plan: 'unlimited' }));
const auth = { authorization: `Bearer ${token}` };

describe('control plane served by the request hook (no route file)', () => {
  it('answers the extension, applies a pushed mock to fetch and axios, and reports it', async () => {
    create();
    const backend = await startBackend();
    // The app has no ApiLens route at all: an unknown path would be its own 404.
    const app = await listen(async (req, res) => {
      if (!req.url?.startsWith('/myaccount')) return json(res, 404, { error: 'app 404' });
      const viaFetch = (await fetch(`${backend}/billing/1`)).status;
      const viaAxios = await axios.get(`${backend}/usage/1`).then((r) => r.status, (error) => error.response?.status ?? 0);
      json(res, 200, { viaFetch, viaAxios });
    });

    expect((await fetch(`${app}/api/__apilens/health`)).status).toBe(401);
    const health = (await (await fetch(`${app}/api/__apilens/health`, { headers: auth })).json()) as ControlHealth;
    expect(health).toMatchObject({ sdkVersion: '0.4.0', enabled: true, configIssues: [] });
    // The App Router folder spelling reaches the same handler.
    expect((await fetch(`${app}/api/%5F_apilens/health`, { headers: auth })).status).toBe(200);

    const now = Date.now();
    const rules: ServerMockRule[] = [{
      id: 'down', name: 'Billing and usage down', description: '', enabled: true, priority: 1,
      match: { method: 'GET', urlPattern: '/(billing|usage)/', matchType: 'regex', kind: 'client' },
      action: { type: 'status-code', statusCode: 503 },
      applyMode: 'always', appliedCount: 0, createdAt: now, updatedAt: now,
    }];
    const put = await fetch(`${app}/api/__apilens/rules`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ rules }),
    });
    expect(put.status).toBe(200);

    expect(await (await fetch(`${app}/myaccount/billing`)).json()).toEqual({ viaFetch: 503, viaAxios: 503 });
    await sdk!.flush();

    const page = (await (await fetch(`${app}/api/__apilens/calls?since=0`, { headers: auth })).json()) as ControlCallsResponse;
    const clients = page.calls.filter((call) => call.kind === 'client');
    expect(clients.map((call) => call.mockedBy)).toEqual(['Billing and usage down', 'Billing and usage down']);
    expect(page.calls.find((call) => call.kind === 'server')?.path).toBe('/myaccount/billing');
    // Control traffic itself is never captured.
    expect(page.calls.some((call) => call.path.includes('apilens'))).toBe(false);
    const after = (await (await fetch(`${app}/api/__apilens/rules`, { headers: auth })).json()) as { rules: ServerMockRule[] };
    expect(after.rules[0]?.appliedCount).toBe(2);
  });

  it('leaves the path to the app when the control plane is off', async () => {
    create({ control: undefined });
    const app = await listen((_req, res) => json(res, 404, { error: 'app 404' }));
    const response = await fetch(`${app}/api/__apilens/health`, { headers: auth });
    expect(await response.json()).toEqual({ error: 'app 404' });
  });

  it('honours a custom mount path and rejects oversized bodies', async () => {
    create({ control: { enabled: true, token, path: '/qa/lens/' } });
    const app = await listen((_req, res) => json(res, 404, {}));
    expect((await fetch(`${app}/qa/lens/health`, { headers: auth })).status).toBe(200);
    const huge = await fetch(`${app}/qa/lens/rules`, { method: 'PUT', headers: auth, body: 'x'.repeat(1024 * 1024 + 10) });
    expect(huge.status).toBe(413);
  });
});

describe('outgoing attribution', () => {
  it('never captures tracer agents or configured hosts, and counts what it skipped', async () => {
    const backend = await startBackend();
    const agent = await startBackend();
    process.env.DD_TRACE_AGENT_URL = agent;
    const instance = create({ ignoreOutgoing: [new URL(backend).host] });
    const app = await listen(async (_req, res) => {
      await fetch(`${agent}/v0.4/traces`, { method: 'PUT' });
      await fetch(`${backend}/billing/1`);
      json(res, 200, {});
    });

    await (await fetch(`${app}/api/x`)).text();
    await instance.flush();
    expect(instance.calls().filter((call) => call.kind === 'client')).toHaveLength(0);
    expect(instance.diagnostics.ignoredOutgoingCalls).toBe(2);
  });

  it('matches hosts, ports, URL prefixes and patterns', () => {
    const ignored = outgoingMatcher([':8126', 'telemetry.internal', 'auth.local:9000', 'https://cdn.example.com/static/', /\/healthz$/]);
    expect(ignored('http://127.0.0.1:8126/v0.4/traces')).toBe(true);
    expect(ignored('http://dd-agent:8126/telemetry')).toBe(true);
    expect(ignored('https://eu.telemetry.internal/x')).toBe(true);
    expect(ignored('http://auth.local:9000/token')).toBe(true);
    expect(ignored('http://auth.local:9001/token')).toBe(false);
    expect(ignored('https://cdn.example.com/static/app.js')).toBe(true);
    expect(ignored('https://cdn.example.com/content')).toBe(false);
    expect(ignored('https://jcs.example.com/healthz')).toBe(true);
    expect(ignored('https://jcs.example.com/billing')).toBe(false);
  });

  it('skips background calls that start after the response was sent', async () => {
    const backend = await startBackend();
    const instance = create();
    let late: Promise<unknown> = Promise.resolve();
    const app = await listen((_req, res) => {
      json(res, 200, {});
      // A tracer flush or token refresh scheduled from inside the request.
      res.once('finish', () => { late = new Promise((resolve) => setTimeout(() => resolve(fetch(`${backend}/late`)), 10)); });
    });

    await (await fetch(`${app}/api/x`)).text();
    await late;
    await instance.flush();
    expect(instance.calls().some((call) => call.path === '/late')).toBe(false);
    expect(instance.diagnostics.lateCallsSkipped).toBe(1);

    await instance.shutdown();
    const keeping = create({ autoInstrument: { recordAfterResponse: true } });
    await (await fetch(`${app}/api/x`)).text();
    await late;
    await keeping.flush();
    expect(keeping.calls().some((call) => call.path === '/late')).toBe(true);
  });
});

describe('patches and boot safety', () => {
  it('puts http.request, Server.emit and fetch back on shutdown', async () => {
    const instance = create();
    expect(http.request).not.toBe(originalRequest);
    expect(HttpServer.prototype.emit).not.toBe(originalEmit);
    await instance.shutdown();
    sdk = undefined;
    expect(http.request).toBe(originalRequest);
    expect(HttpServer.prototype.emit).toBe(originalEmit);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('boots with every secret missing and patches nothing while disabled', () => {
    expect(() => create({ enabled: false, control: { enabled: true, token: '' }, agentToken: undefined, reportToAgent: true })).not.toThrow();
    expect(http.request).toBe(originalRequest);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('boots enabled with a bad agent URL and a bad origin, reporting both', () => {
    const instance = create({ reportToAgent: true, agentToken: 'agent-token-0123456789abcdef', agentUrl: 'https://agent.example.com', allowedAppOrigins: ['not a url'] });
    expect(instance.diagnostics.configIssues.map((issue) => issue.setting).sort()).toEqual(['agentUrl', 'allowedAppOrigins']);
  });
});

describe('memory and redaction', () => {
  const call = (bytes: number): Omit<ServerCall, 'seq'> => ({
    spanId: 's', traceId: 't', parentSpanId: null, sessionId: 'qa', scenarioId: null, serviceName: 'x', kind: 'client',
    method: 'GET', url: 'http://x/a', origin: 'http://x', path: '/a', query: {}, statusCode: 200, status: 'ok',
    startedAt: 0, endedAt: 1, durationMs: 1, bodyDurationMs: null, requestHeaders: {}, responseHeaders: {},
    requestBody: null, responseBody: { content: 'x'.repeat(bytes), encoding: 'utf8', contentType: 'text/plain', byteLength: bytes, truncated: false, redacted: false },
    requestBodyOmitted: null, responseBodyOmitted: null, error: null, mockedBy: null,
  });

  it('evicts the oldest calls once the byte budget is reached', () => {
    const buffer = new CallBuffer(500, 1024 * 1024);
    for (let index = 0; index < 20; index += 1) buffer.add(call(128 * 1024));
    expect(buffer.byteSize()).toBeLessThanOrEqual(1024 * 1024);
    expect(buffer.size()).toBeLessThan(20);
    expect(buffer.droppedCount()).toBe(20 - buffer.size());
    expect(buffer.latestSeq()).toBe(20);
  });

  it('redacts personal data keys and values without hiding look-alike fields', () => {
    const { text, redacted } = redactBody(JSON.stringify({
      msisdn: '353871234567', billingMsisdn: '353871234567', mobile: '0871234567', mobilePlanName: 'Unlimited',
      contact: { emailAddress: 'a@b.ie', note: 'call jane.doe@example.com', dateOfBirth: '1990-01-01' },
      refund: 'to IE29 AIBK 9311 5212 3456 78', eircode: 'D02X285',
    }), 'application/json');
    const parsed = JSON.parse(text);
    expect(redacted).toBe(true);
    expect(parsed).toMatchObject({
      msisdn: '[REDACTED]', billingMsisdn: '[REDACTED]', mobile: '[REDACTED]', mobilePlanName: 'Unlimited', eircode: 'D02X285',
      contact: { emailAddress: '[REDACTED]', note: 'call [REDACTED_EMAIL]', dateOfBirth: '[REDACTED]' },
      refund: 'to [REDACTED_IBAN]',
    });
  });
});
