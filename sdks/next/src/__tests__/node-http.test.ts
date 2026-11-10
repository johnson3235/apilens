import { afterEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import http, { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { ApiLensNextSDK } from '../index';
import type { ServerMockRule } from '../types';

/**
 * Calls made with axios or plain `http.request` inside an unmodified handler,
 * the way most enterprise BFFs talk to their backends.
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
    // The backend runs in this process too; keep its own incoming side out.
    autoInstrument: { ignorePaths: ['/svc/'] },
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

const rule = (overrides: Partial<ServerMockRule>): ServerMockRule => {
  const now = Date.now();
  return {
    id: 'r1', name: 'billing down', description: '', enabled: true, priority: 1,
    match: { method: 'ANY', urlPattern: '*/svc/billing*', matchType: 'glob', kind: 'client' },
    action: { type: 'status-code', statusCode: 503, body: '{"error":"down"}' },
    applyMode: 'always', appliedCount: 0, createdAt: now, updatedAt: now,
    ...overrides,
  };
};

async function backend(): Promise<string> {
  return listen((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url?.startsWith('/svc/gzip')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(JSON.stringify({ compressed: true })));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-service': 'billing' });
      res.end(JSON.stringify({ path: req.url, received: body || null, amount: 12.99 }));
    });
  });
}

/** An app route that knows nothing about ApiLens. */
async function app(handler: () => Promise<unknown>): Promise<string> {
  return listen(async (_req, res) => {
    try {
      const result = await handler();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: (error as { code?: string }).code ?? null, status: (error as { response?: { status?: number } }).response?.status ?? null }));
    }
  });
}

describe('Node http/https clients (axios, got, plain http.request)', () => {
  it('captures axios calls with payloads, linked to the incoming request', async () => {
    const instance = create();
    const svc = await backend();
    const base = await app(async () => {
      const read = await axios.get(`${svc}/svc/billing/3055861`);
      const write = await axios.post(`${svc}/svc/orders`, { plan: 'unlimited' });
      return { amount: read.data.amount, received: write.data.received };
    });

    const result = await (await fetch(`${base}/api/summary`)).json();
    await instance.flush();

    expect(result).toEqual({ amount: 12.99, received: '{"plan":"unlimited"}' });
    const page = instance.calls().find((call) => call.kind === 'server');
    const children = instance.calls().filter((call) => call.kind === 'client');
    expect(children.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /svc/billing/3055861', 'POST /svc/orders']);
    expect(children.every((call) => call.parentSpanId === page?.spanId && call.statusCode === 200)).toBe(true);
    expect(JSON.parse(children[0]!.responseBody!.content)).toMatchObject({ amount: 12.99 });
    expect(children[0]!.responseHeaders['x-service']).toBe('billing');
    expect(JSON.parse(children[1]!.requestBody!.content)).toEqual({ plan: 'unlimited' });
  });

  it('decodes compressed upstream responses for display, leaving the app its own copy', async () => {
    const instance = create();
    const svc = await backend();
    const base = await app(async () => (await axios.get(`${svc}/svc/gzip`)).data);

    expect(await (await fetch(`${base}/api/x`)).json()).toEqual({ compressed: true });
    await instance.flush();
    const call = instance.calls().find((entry) => entry.kind === 'client');
    expect(JSON.parse(call!.responseBody!.content)).toEqual({ compressed: true });
  });

  it('serves a mock to axios without touching the backend', async () => {
    const instance = create();
    let hits = 0;
    const svc = await listen((_req, res) => { hits += 1; res.end('{}'); });
    instance.setServerMockRules([rule({})]);
    const base = await app(async () => (await axios.get(`${svc}/svc/billing/1`)).data);

    const result = await (await fetch(`${base}/api/x`)).json();
    await instance.flush();

    expect(result).toEqual({ code: 'ERR_BAD_RESPONSE', status: 503 });
    expect(hits).toBe(0);
    expect(instance.calls().find((call) => call.kind === 'client')).toMatchObject({ statusCode: 503, mockedBy: 'billing down' });
  });

  it('simulates a refused connection the way axios reports one', async () => {
    const instance = create();
    instance.setServerMockRules([rule({ action: { type: 'network-error' } })]);
    const base = await app(async () => axios.get('http://billing.internal/svc/billing/1'));

    expect(await (await fetch(`${base}/api/x`)).json()).toEqual({ code: 'ECONNREFUSED', status: null });
    await instance.flush();
    expect(instance.calls().find((call) => call.kind === 'client')).toMatchObject({ statusCode: null, mockedBy: 'billing down' });
  });

  it('rewrites the real response for passthrough-mutate', async () => {
    const instance = create();
    const svc = await backend();
    instance.setServerMockRules([rule({
      action: { type: 'passthrough-mutate', fieldMutations: [{ path: 'amount', operation: 'set', value: 0 }] },
    })]);
    const base = await app(async () => (await axios.get(`${svc}/svc/billing/1`)).data);

    const result = await (await fetch(`${base}/api/x`)).json();
    await instance.flush();
    expect(result).toMatchObject({ amount: 0, path: '/svc/billing/1' });
    expect(instance.calls().find((call) => call.kind === 'client')?.mockedBy).toBe('billing down');
  });

  it('captures plain http.get and records connection failures without swallowing them', async () => {
    const instance = create();
    const svc = await backend();
    const base = await app(async () => {
      const status = await new Promise<number>((resolve) => http.get(`${svc}/svc/plain`, (res) => { res.resume(); resolve(res.statusCode!); }));
      const failure = await new Promise<string>((resolve) => {
        http.get('http://127.0.0.1:1/svc/unreachable').on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'none'));
      });
      return { status, failure };
    });

    expect(await (await fetch(`${base}/api/x`)).json()).toEqual({ status: 200, failure: 'ECONNREFUSED' });
    await instance.flush();
    const calls = instance.calls().filter((call) => call.kind === 'client');
    expect(calls.map((call) => [call.path, call.statusCode, call.error])).toEqual([
      ['/svc/plain', 200, null],
      ['/svc/unreachable', null, 'ECONNREFUSED'],
    ]);
  });

  it('leaves calls outside a request, and with captureNodeHttp off, alone', async () => {
    const instance = create();
    const svc = await backend();
    await axios.get(`${svc}/svc/billing/1`); // no incoming request around it
    await instance.flush();
    expect(instance.calls()).toHaveLength(0);
    await instance.shutdown();

    const off = create({ captureNodeHttp: false });
    const base = await app(async () => (await axios.get(`${svc}/svc/billing/1`)).data);
    await (await fetch(`${base}/api/x`)).text();
    await off.flush();
    expect(off.calls().filter((call) => call.kind === 'client')).toHaveLength(0);
  });
});
