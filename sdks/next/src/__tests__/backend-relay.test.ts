import { afterEach, describe, expect, it } from 'vitest';
import http, { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiLensNextSDK, withSessionBaggage } from '../index';
import type { IncomingMessage } from 'node:http';
import { ApiLensRelay, parseRoutesEnv, traceFromHeaders, withCallers } from '../relay';
import type { ServerCall, ServerMockRule } from '../types';

/**
 * A Spring backend ("jcs") calls TMF services through the relay. The app's
 * control plane is a real SDK instance; the TMF is a plain Node server.
 */

const token = 'backend-relay-control-token-0123456789';
const servers: Server[] = [];
const relays: ApiLensRelay[] = [];
const instances: ApiLensNextSDK[] = [];
const TRACE = '0af7651916cd43dd8448eb211c80319c';
const PARENT = 'b7ad6b7169203331';

afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const instance of instances.splice(0)) await instance.shutdown();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The app the extension connects to. */
async function app(): Promise<{ base: string; sdk: ApiLensNextSDK }> {
  const sdk = new ApiLensNextSDK({
    serviceName: 'clear-bff', enabled: true, reportToAgent: false, allowedAppOrigins: ['*'],
    captureBodies: { request: true, response: true }, control: { enabled: true, token },
  });
  instances.push(sdk);
  // The app and the relay share this test process; in production they never do. Without this the
  // app would switch capture on at the first control request and also record the relay's own traffic.
  (sdk as unknown as { stats: { installed: boolean } }).stats.installed = true;
  const base = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await sdk.handleControlRequest(new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>,
      body: req.method === 'GET' || req.method === 'DELETE' ? undefined : Buffer.concat(chunks),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }));
  return { base: `${base}/api/__apilens`, sdk };
}

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: string }

/** A TMF service: answers gzipped JSON with two cookies, and remembers what it was sent. */
async function tmf(answer: { status?: number; json?: unknown } = {}): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const base = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const body = gzipSync(JSON.stringify(answer.json ?? { id: 'PO-1', state: 'acknowledged', customer: { email: 'a@b.co' } }));
    res.writeHead(answer.status ?? 201, [
      'Content-Type', 'application/json', 'Content-Encoding', 'gzip', 'Content-Length', String(body.byteLength),
      'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'X-Tmf-Version', '4.0',
    ]);
    res.end(body);
  }));
  return { base, seen };
}

async function relay(routes: Record<string, string>, control: string, shared = true): Promise<string> {
  const instance = new ApiLensRelay({ routes, control: { url: control, token }, callerName: 'jcs', name: 'jcs-relay', sharedEnvironment: shared, flushIntervalMs: 60_000, rulesIntervalMs: 60_000 });
  relays.push(instance);
  const server = await instance.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Raw HTTP, so compressed bytes and repeated headers are seen exactly as the backend would. */
function send(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method ?? 'GET', headers: init.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

const tagged = (session = 'qa-sara', extra: Record<string, string> = {}) => ({
  'x-qa-session-id': session, traceparent: `00-${TRACE}-${PARENT}-01`, 'content-type': 'application/json', ...extra,
});

function relayInstance(): ApiLensRelay {
  return relays[relays.length - 1]!;
}

async function recorded(sdk: ApiLensNextSDK): Promise<ServerCall[]> {
  await relayInstance().flush();
  return sdk.calls();
}

const rule = (overrides: Partial<ServerMockRule> & { action: ServerMockRule['action'] }): ServerMockRule => ({
  id: `rule-${Math.random().toString(36).slice(2)}`, name: 'TMF622 down', description: '', enabled: true, priority: 1,
  match: { method: 'POST', urlPattern: '*/productOrder', matchType: 'glob', kind: 'client' },
  applyMode: 'always', appliedCount: 0, createdAt: Date.now(), updatedAt: Date.now(), ...overrides,
});

describe('backend relay', () => {
  it('passes other squads’ traffic through byte for byte and records none of it', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf622: `${upstream.base}/tmf-api/productOrdering/v4` }, base);

    const response = await send(`${url}/tmf622/productOrder?fields=id`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer real' }, body: '{"note":"x"}',
    });

    expect(response.status).toBe(201);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(JSON.parse(gunzipSync(response.body).toString('utf8'))).toMatchObject({ id: 'PO-1' });
    expect(upstream.seen[0]).toMatchObject({ method: 'POST', url: '/tmf-api/productOrdering/v4/productOrder?fields=id', body: '{"note":"x"}' });
    expect(upstream.seen[0]!.headers.authorization).toBe('Bearer real');
    expect(upstream.seen[0]!.headers.host).toBe(new URL(upstream.base).host);
    expect(await recorded(sdk)).toHaveLength(0);
    expect(relayInstance().status()).toMatchObject({ forwarded: 1, unattributed: 1, captured: 0 });
  });

  it('records a QA session’s TMF call in the app, on the BFF’s trace, labelled with its route', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf622: upstream.base }, base);

    const response = await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged(), body: '{"item":"fiber-500","password":"x"}' });
    expect(response.status).toBe(201);
    expect(response.headers['content-encoding']).toBe('gzip');

    const [call] = await recorded(sdk);
    expect(call).toMatchObject({
      kind: 'client', serviceName: 'jcs', layer: 'tmf622', sessionId: 'qa-sara', traceId: TRACE, parentSpanId: PARENT,
      method: 'POST', path: '/productOrder', statusCode: 201, status: 'ok', mockedBy: null,
    });
    expect(call!.requestBody?.content).toContain('fiber-500');
    expect(call!.requestBody?.content).not.toContain('"x"');
    expect(call!.responseBody?.content).toContain('acknowledged');
    expect(call!.responseBody?.content).not.toContain('a@b.co');
    expect(call!.requestHeaders['x-qa-session-id']).toBe('[REDACTED]');
    expect(sdk.health().relays?.[0]).toMatchObject({ name: 'jcs-relay', routes: ['tmf622'], sharedEnvironment: true, captured: 1 });
  });

  it('records the caller a route names, so OSB calls are shown as made by the TMF layer', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const instance = new ApiLensRelay({ routes: [{ name: 'osb', target: upstream.base, caller: 'tmf' }], control: { url: base, token }, callerName: 'jcs' });
    relays.push(instance);
    const server = await instance.listen(0, '127.0.0.1');
    await send(`http://127.0.0.1:${(server.address() as AddressInfo).port}/osb/order`, { method: 'POST', headers: tagged(), body: '{}' });
    expect((await recorded(sdk))[0]).toMatchObject({ serviceName: 'tmf', layer: 'osb' });
  });

  it('recognises the session from W3C baggage, as OpenTelemetry propagates it', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf629: upstream.base }, base);
    await send(`${url}/tmf629/customer/42`, { headers: { baggage: `other=1,${withSessionBaggage(null, 'qa-omar')}`, traceparent: `00-${TRACE}-${PARENT}-01` } });
    expect((await recorded(sdk))[0]).toMatchObject({ sessionId: 'qa-omar', layer: 'tmf629', path: '/customer/42' });
  });

  it('answers a tester’s call from a mock, and only that tester’s', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf622: upstream.base }, base);
    sdk.setServerMockRules([rule({ match: { method: 'POST', urlPattern: '*/productOrder', matchType: 'glob', kind: 'client', sessionId: 'qa-sara' }, action: { type: 'status-code', statusCode: 503, body: '{"code":"TMF-503"}' } })]);
    await relayInstance().refreshRules();

    const mine = await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged('qa-sara'), body: '{}' });
    const colleague = await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged('qa-omar'), body: '{}' });
    const otherSquad = await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    expect(mine.status).toBe(503);
    expect(mine.body.toString()).toBe('{"code":"TMF-503"}');
    expect(mine.headers['x-apilens-mock']).toBe('TMF622 down');
    expect(colleague.status).toBe(201);
    expect(otherSquad.status).toBe(201);
    expect(upstream.seen).toHaveLength(2);

    const calls = await recorded(sdk);
    expect(calls.find((call) => call.sessionId === 'qa-sara')).toMatchObject({ statusCode: 503, mockedBy: 'TMF622 down', status: 'error' });
    expect(sdk.serverMockRules()[0]!.appliedCount).toBe(1);
  });

  it('never applies an unscoped rule to traffic without a QA session', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf622: upstream.base }, base);
    sdk.setServerMockRules([rule({ action: { type: 'status-code', statusCode: 500 } })]);
    await relayInstance().refreshRules();
    expect((await send(`${url}/tmf622/productOrder`, { method: 'POST', body: '{}' })).status).toBe(201);
    expect((await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged(), body: '{}' })).status).toBe(500);
  });

  it('changes fields in the real TMF answer', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf({ status: 200, json: { id: 'PO-1', state: 'acknowledged', items: [{ price: 10 }] } });
    const url = await relay({ tmf622: upstream.base }, base);
    sdk.setServerMockRules([rule({ action: { type: 'passthrough-mutate', fieldMutations: [{ path: 'state', operation: 'set', value: 'rejected' }, { path: 'items[0].price', operation: 'nullify' }] } })]);
    await relayInstance().refreshRules();

    const response = await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged(), body: '{}' });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(JSON.parse(response.body.toString())).toEqual({ id: 'PO-1', state: 'rejected', items: [{ price: null }] });
    expect((await recorded(sdk))[0]!.responseBody?.content).toContain('rejected');
  });

  it('drops the connection for a simulated network error, as a down service would', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf622: upstream.base }, base);
    sdk.setServerMockRules([rule({ action: { type: 'network-error' } })]);
    await relayInstance().refreshRules();
    await expect(send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged(), body: '{}' })).rejects.toThrow();
    expect(upstream.seen).toHaveLength(0);
    expect((await recorded(sdk))[0]).toMatchObject({ statusCode: null, status: 'error', mockedBy: 'TMF622 down' });
  });

  it('explains an unknown route or an unreachable service instead of hanging', async () => {
    const { base, sdk } = await app();
    const url = await relay({ osb: 'http://127.0.0.1:9' }, base);
    const unknown = await send(`${url}/vesta/orders`);
    expect(unknown.status).toBe(502);
    expect(unknown.body.toString()).toContain('Known routes: osb');

    const down = await send(`${url}/osb/orders`, { headers: tagged() });
    expect(down.status).toBe(502);
    expect(down.headers['x-apilens-relay']).toBe('upstream-unreachable');
    expect((await recorded(sdk))[0]).toMatchObject({ layer: 'osb', statusCode: null, status: 'error' });

    const health = await send(`${url}/__relay/health`);
    expect(JSON.parse(health.body.toString())).toMatchObject({ ok: true, routes: ['osb'] });
  });

  it('keeps calls while the app is unreachable and delivers them later', async () => {
    const upstream = await tmf();
    const url = await relay({ tmf622: upstream.base }, 'http://127.0.0.1:9/api/__apilens');
    await send(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged(), body: '{}' });
    await relayInstance().flush();
    expect(relayInstance().lastError).toMatch(/^ingest:/);
    expect(relayInstance().status()).toMatchObject({ captured: 1, dropped: 0 });
  });
});

describe('relay configuration', () => {
  it('reads routes from one environment variable', () => {
    expect(parseRoutesEnv('tmf622=https://a.internal/tmf-api, osb=http://osb:8080\nvesta=https://v')).toEqual({
      tmf622: 'https://a.internal/tmf-api', osb: 'http://osb:8080', vesta: 'https://v',
    });
    expect(() => parseRoutesEnv('tmf622')).toThrow(/name=url/);
    expect(withCallers({ tmf622: 'https://a', osb: 'https://o' }, 'osb=tmf')).toEqual([
      { name: 'tmf622', target: 'https://a' }, { name: 'osb', target: 'https://o', caller: 'tmf' },
    ]);
    expect(() => withCallers({ tmf622: 'https://a' }, 'vesta=tmf')).toThrow(/not in APILENS_RELAY_ROUTES/);
    expect(() => new ApiLensRelay({ routes: { tmf622: 'ftp://x' }, control: { url: 'http://a', token } })).toThrow(/http or https/);
    expect(() => new ApiLensRelay({ routes: { tmf622: 'http://x' }, control: { url: 'http://a', token: 'short' } })).toThrow(/token/);
  });

  it('reads the caller’s trace from traceparent or B3', () => {
    const from = (headers: Record<string, string>) => traceFromHeaders({ headers } as unknown as IncomingMessage);
    expect(from({ traceparent: `00-${TRACE}-${PARENT}-01` })).toEqual({ traceId: TRACE, spanId: PARENT });
    expect(from({ b3: `${TRACE}-${PARENT}-1` })).toEqual({ traceId: TRACE, spanId: PARENT });
    expect(from({ 'x-b3-traceid': '8448eb211c80319c', 'x-b3-spanid': PARENT })).toEqual({ traceId: '00000000000000008448eb211c80319c', spanId: PARENT });
    expect(from({ traceparent: 'garbage' })).toBeNull();
  });

  it('adds the session to baggage once, keeping what is there', () => {
    expect(withSessionBaggage(null, 'qa-1')).toBe('x-qa-session-id=qa-1');
    expect(withSessionBaggage('tenant=7', 'qa-1')).toBe('tenant=7,x-qa-session-id=qa-1');
    expect(withSessionBaggage('x-qa-session-id=qa-1', 'qa-1')).toBeNull();
    expect(withSessionBaggage(null, 'apilens-ambient')).toBeNull();
  });
});


describe('relay when the backend gives up', () => {
  it('records a slow mock the backend abandoned, instead of keeping it open', async () => {
    const { base, sdk } = await app();
    const upstream = await tmf();
    const url = await relay({ tmf622: upstream.base }, base);
    sdk.setServerMockRules([rule({ action: { type: 'status-code', statusCode: 200, delayMs: 5_000 } })]);
    await relayInstance().refreshRules();
    const request = http.request(`${url}/tmf622/productOrder`, { method: 'POST', headers: tagged() });
    request.on('error', () => undefined);
    request.end('{}');
    await new Promise((resolve) => setTimeout(resolve, 100));
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await recorded(sdk))[0]).toMatchObject({ statusCode: null, mockedBy: 'TMF622 down', error: expect.stringContaining('closed the connection') });
  });
});
