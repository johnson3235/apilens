import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { ApiLensNextSDK } from '../index';
import type { ServerMockRule } from '../types';

/**
 * The app server below stands in for `next start`: a plain http.Server whose
 * handlers know nothing about ApiLens, like an unmodified page or route.
 */

const originalFetch = globalThis.fetch;
let sdk: ApiLensNextSDK | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  globalThis.fetch = originalFetch;
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

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
  let text = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { text += chunk; });
  req.on('end', () => resolve(text));
});

/** Backend services, kept out of the capture by an ignore rule like a real separate host would be. */
const startBackend = () => listen((req, res) => json(res, 200, { path: req.url, total: { value: 12.99 } }));

describe('automatic instrumentation (no application code)', () => {
  it('captures a server-rendered page and the backend calls it makes', async () => {
    const instance = create({ autoInstrument: { ignorePaths: ['/balance', '/billing'] } });
    const backend = await startBackend();
    const app = await listen(async (_req, res) => {
      const [a, b] = await Promise.all([
        fetch(`${backend}/balance/3055861`).then((r) => r.json()),
        fetch(`${backend}/billing/3055861`).then((r) => r.json()),
      ]);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<main>${a.total.value} ${b.total.value}</main>`);
    });

    const html = await (await fetch(`${app}/myaccount/billing?contactId=3055861&_rsc=abc`, {
      headers: { 'x-qa-session-id': 'qa-1', 'x-test-scenario-id': 'billing' },
    })).text();
    await instance.flush();

    expect(html).toContain('12.99');
    const page = instance.calls().find((call) => call.kind === 'server');
    const children = instance.calls().filter((call) => call.kind === 'client');
    expect(page).toMatchObject({ method: 'GET', path: '/myaccount/billing', statusCode: 200, sessionId: 'qa-1', scenarioId: 'billing' });
    expect(page?.query).toHaveProperty('contactId');
    expect(page?.query).not.toHaveProperty('_rsc');
    expect(page?.responseBodyOmitted).toBe('Not captured: page markup');
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.parentSpanId === page?.spanId && child.traceId === page?.traceId)).toBe(true);
  });

  it('applies server mocks inside code that was never wrapped', async () => {
    const instance = create({ autoInstrument: { ignorePaths: ['/billing'] } });
    const backend = await startBackend();
    const app = await listen(async (_req, res) => json(res, 200, { upstream: (await fetch(`${backend}/billing/1`)).status }));
    const now = Date.now();
    instance.setServerMockRules([{
      id: 'r1', name: 'billing down', description: '', enabled: true, priority: 1,
      match: { method: 'GET', urlPattern: '*/billing/*', matchType: 'glob', kind: 'client' },
      action: { type: 'status-code', statusCode: 503 },
      applyMode: 'always', appliedCount: 0, createdAt: now, updatedAt: now,
    } satisfies ServerMockRule]);

    const body = await (await fetch(`${app}/myaccount`)).json();
    await instance.flush();

    expect(body.upstream).toBe(503);
    expect(instance.calls().find((call) => call.kind === 'client')?.mockedBy).toBe('billing down');
  });

  it('captures request and compressed response payloads of an API route', async () => {
    const instance = create();
    const app = await listen(async (req, res) => {
      const received = JSON.parse(await readBody(req));
      res.writeHead(201, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ ok: true, echoed: received.plan })));
    });

    const response = await fetch(`${app}/api/orders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'unlimited' }),
    });
    expect(await response.json()).toEqual({ ok: true, echoed: 'unlimited' });
    await instance.flush();

    const call = instance.calls()[0];
    expect(call).toMatchObject({ kind: 'server', method: 'POST', path: '/api/orders', statusCode: 201 });
    expect(call?.requestBody?.content).toContain('unlimited');
    expect(JSON.parse(call?.responseBody?.content ?? 'null')).toEqual({ ok: true, echoed: 'unlimited' });
  });

  it('skips Next assets, the control endpoint and idle page loads', async () => {
    const instance = create();
    const app = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>hi</p>'); });

    for (const path of ['/_next/static/chunk.js', '/api/__apilens/health', '/favicon.ico', '/logo.png', '/myaccount']) {
      await (await fetch(`${app}${path}`)).text();
    }
    await instance.flush();
    expect(instance.calls()).toHaveLength(0);

    await instance.shutdown();
    const everything = create({ autoInstrument: { recordAllRequests: true } });
    await (await fetch(`${app}/myaccount`)).text();
    await everything.flush();
    expect(everything.calls()).toHaveLength(1);
  });

  it('always records failures, even without backend calls', async () => {
    const instance = create();
    const app = await listen((_req, res) => json(res, 500, { error: 'boom' }));
    await (await fetch(`${app}/myaccount`)).text();
    await instance.flush();
    expect(instance.calls()[0]).toMatchObject({ kind: 'server', statusCode: 500, status: 'error' });
  });

  it('records a wrapped route once, with the wrapper taking over', async () => {
    const instance = create({ autoInstrument: { ignorePaths: ['/billing'] } });
    const backend = await startBackend();
    const route = instance.wrapRoute(async () => Response.json({ upstream: (await fetch(`${backend}/billing/1`)).status }));
    const app = await listen(async (req, res) => {
      const response = await route(new Request(`http://localhost${req.url}`, { headers: { host: req.headers.host ?? '' } }), undefined);
      json(res, response.status, await response.json());
    });

    await (await fetch(`${app}/api/billing`)).text();
    await instance.flush();

    const servers = instance.calls().filter((call) => call.kind === 'server');
    const client = instance.calls().find((call) => call.kind === 'client');
    expect(servers).toHaveLength(1);
    expect(client?.parentSpanId).toBe(servers[0]?.spanId);
  });

  it('does not re-wrap fetch once Next has patched it', async () => {
    create();
    const ours = globalThis.fetch;
    const nextPatched = Object.assign((input: RequestInfo | URL, init?: RequestInit) => ours(input, init), { __nextPatched: true });
    globalThis.fetch = nextPatched as typeof fetch;
    const app = await listen((_req, res) => json(res, 200, {}));

    await (await fetch(`${app}/api/a`)).text();
    await (await fetch(`${app}/api/b`)).text();
    expect(globalThis.fetch).toBe(nextPatched);
  });

  it('stays out of the way when autoInstrument is false or the SDK is off', async () => {
    const off = create({ autoInstrument: false });
    const app = await listen((_req, res) => json(res, 500, {}));
    await (await fetch(`${app}/api/x`)).text();
    await off.flush();
    expect(off.calls()).toHaveLength(0);
    await off.shutdown();

    const disabled = create({ enabled: false });
    await (await fetch(`${app}/api/x`)).text();
    expect(disabled.calls()).toHaveLength(0);
  });
});
