import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK } from '../index';
import type { ServerMockRule } from '../types';

/**
 * Simulates Vercel: an "API function" process hosts the control endpoint the
 * extension polls, and a separate "page function" process renders pages.
 * The page process must relay its captures and read rules over HTTP.
 */

const token = 'relay-test-control-token-0123456789';
const originalFetch = globalThis.fetch;
const servers: Server[] = [];
const instances: ApiLensNextSDK[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.shutdown();
  globalThis.fetch = originalFetch;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function sdk(relay: boolean): ApiLensNextSDK {
  const instance = new ApiLensNextSDK({
    serviceName: 'clear-demo-bff',
    enabled: true,
    reportToAgent: false,
    allowedAppOrigins: ['*'],
    captureWithoutSession: true,
    captureBodies: { request: true, response: true },
    control: { enabled: true, token, ...(relay ? { relay: {} } : {}) },
  });
  instances.push(instance);
  return instance;
}

async function listen(handler: (request: Request) => Promise<Response> | Response): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const control = (base: string, path: string, init: RequestInit = {}) =>
  originalFetch(`${base}/api/__apilens/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });

describe('relay mode (serverless: pages and API routes in separate functions)', () => {
  it("delivers a page function's captures to the process the extension polls", async () => {
    const hub = sdk(true);
    const backend = await listen(() => Response.json({ total: { value: 12.99 } }));
    const app = await listen((request) => hub.handleControlRequest(request));
    const page = sdk(true);

    // The extension has connected to the hub before the page renders.
    expect((await control(app, 'health')).status).toBe(200);

    await page.traceRender({ path: '/myaccount/billing', headers: new Headers({ host: new URL(app).host }) },
      () => fetch(`${backend}/api/services/billing/3055861`).then((response) => response.json()));
    await page.flush();

    expect(page.calls()).toHaveLength(0);
    const { calls } = await (await control(app, 'calls?since=0')).json() as { calls: Array<{ kind: string; path: string; spanId: string; parentSpanId: string | null }> };
    const pageCall = calls.find((call) => call.kind === 'server');
    expect(pageCall?.path).toBe('/myaccount/billing');
    expect(calls.find((call) => call.kind === 'client')).toMatchObject({ path: '/api/services/billing/3055861', parentSpanId: pageCall?.spanId });
  });

  it('applies rules saved on the hub, and a one-shot rule fires only once across processes', async () => {
    const hub = sdk(true);
    const backend = await listen(() => Response.json({ ok: true }));
    const app = await listen((request) => hub.handleControlRequest(request));
    const page = sdk(true);
    const now = Date.now();
    const rule: ServerMockRule = {
      id: 'down', name: 'billing down', description: '', enabled: true, priority: 1,
      match: { method: 'GET', urlPattern: '*/billing/*', matchType: 'glob', kind: 'client' },
      action: { type: 'status-code', statusCode: 503, body: '{}' },
      applyMode: 'once', appliedCount: 0, createdAt: now, updatedAt: now,
    };
    expect((await control(app, 'rules', { method: 'PUT', body: JSON.stringify({ rules: [rule] }) })).status).toBe(200);

    const render = () => page.traceRender({ path: '/myaccount/billing', headers: new Headers({ host: new URL(app).host }) },
      async () => (await fetch(`${backend}/billing/1`)).status);
    expect(await render()).toBe(503);
    await page.flush();
    expect(await render()).toBe(200);
    await page.flush();

    const { rules } = await (await control(app, 'rules')).json() as { rules: ServerMockRule[] };
    expect(rules[0]?.appliedCount).toBe(1);
  });

  it('keeps captures locally once this process serves the extension itself', async () => {
    const hub = sdk(true);
    const app = await listen((request) => hub.handleControlRequest(request));
    await control(app, 'health');
    const route = hub.wrapRoute(async () => Response.json({ ok: true }));
    await route(new Request(`${app}/api/billing/next-bill`), undefined);
    await hub.flush();
    expect(hub.calls()).toHaveLength(1);
    expect(hub.diagnostics.relayFailures).toBe(0);
  });

  it('still renders the page when the relay target is unreachable', async () => {
    const page = sdk(true);
    const result = await page.traceRender({ path: '/p', headers: new Headers({ host: '127.0.0.1:9' }) }, () => ({ fine: true }));
    await page.flush();
    expect(result).toEqual({ fine: true });
    expect(page.diagnostics.relayFailures).toBeGreaterThan(0);
  });

  it('rejects relayed calls without the token, and drops malformed ones', async () => {
    const hub = sdk(false);
    const app = await listen((request) => hub.handleControlRequest(request));
    const anonymous = await originalFetch(`${app}/api/__apilens/ingest`, { method: 'POST', body: JSON.stringify({ calls: [] }) });
    expect(anonymous.status).toBe(401);
    const response = await control(app, 'ingest', { method: 'POST', body: JSON.stringify({ calls: [{ kind: 'nope' }, 'x', null] }) });
    expect(await response.json()).toMatchObject({ accepted: 0 });
    expect(hub.calls()).toHaveLength(0);
  });
});
