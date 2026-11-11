import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK } from '../index';
import type { ControlCallsResponse, ControlHealth } from '../types';

/**
 * Covers the 0.5.0 changes for "connected, but no server calls": capture
 * counters in /health, origins learned from the control plane, installing on
 * the first connection, Next fetch-cache hits, the middleware link and
 * per-pod cursors.
 */

const originalFetch = globalThis.fetch;
const token = 'visibility-control-token-0123456789abcdef';
let sdk: ApiLensNextSDK | undefined;
const servers: Server[] = [];

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  globalThis.fetch = originalFetch;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function create(overrides: Partial<ConstructorParameters<typeof ApiLensNextSDK>[0]> = {}, install = true): ApiLensNextSDK {
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
  if (install) sdk.install();
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
const auth = { authorization: `Bearer ${token}` };

async function health(app: string): Promise<ControlHealth> {
  return (await (await fetch(`${app}/api/__apilens/health`, { headers: auth })).json()) as ControlHealth;
}

/** A backend that counts how often it is really reached. */
async function countingBackend(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const url = await listen((req, res) => { hits += 1; json(res, 200, { path: req.url, plan: 'unlimited' }); });
  return { url, hits: () => hits };
}

type Fetch = typeof fetch & { __nextPatched?: boolean };

/**
 * Next 14.2's patchFetch in miniature: once per process, a URL-keyed cache in
 * front of whatever `globalThis.fetch` was, answering `force-cache` repeats itself.
 */
function nextPatchFetch(style: '14.2' | '14.0' = '14.2'): void {
  if ((globalThis.fetch as Fetch).__nextPatched) return;
  const original = globalThis.fetch;
  const cache = new Map<string, { status: number; body: string; type: string }>();
  const patched: Fetch = async (input, init) => {
    const key = input instanceof Request ? input.url : String(input);
    const cached = init?.cache === 'force-cache' ? cache.get(key) : undefined;
    if (cached) return new Response(cached.body, { status: cached.status, headers: { 'content-type': cached.type } });
    const response = await original(input, init);
    if (init?.cache === 'force-cache') {
      cache.set(key, { status: response.status, body: await response.clone().text(), type: response.headers.get('content-type') ?? '' });
    }
    return response;
  };
  if (style === '14.2') {
    patched.__nextPatched = true;
    globalThis.fetch = patched;
  } else {
    // 14.0 assigns first, then marks whatever the global now is.
    globalThis.fetch = patched;
    (globalThis.fetch as Fetch).__nextPatched = true;
  }
}

describe('Next fetch-cache hits', () => {
  for (const style of ['14.2', '14.0'] as const) {
    it(`records a cached answer as a cache hit, without a second backend call (Next ${style} patch)`, async () => {
      const instance = create();
      const backend = await countingBackend();
      const app = await listen(async (_req, res) => {
        nextPatchFetch(style); // Next patches on every render; only the first one takes.
        const first = await (await fetch(`${backend.url}/plans`, { cache: 'force-cache' })).json();
        const second = await (await fetch(`${backend.url}/plans`, { cache: 'force-cache' })).json();
        json(res, 200, { same: JSON.stringify(first) === JSON.stringify(second) });
      });

      expect(await (await fetch(`${app}/myaccount/plans`)).json()).toEqual({ same: true });
      expect(await (await fetch(`${app}/myaccount/plans`)).json()).toEqual({ same: true });
      await instance.flush();

      expect(backend.hits()).toBe(1);
      const clients = instance.calls().filter((call) => call.kind === 'client');
      expect(clients).toHaveLength(4);
      expect(clients.filter((call) => call.cache === 'hit')).toHaveLength(3);
      const hit = clients.find((call) => call.cache === 'hit');
      expect(hit).toMatchObject({ path: '/plans', statusCode: 200 });
      expect(JSON.parse(hit?.responseBody?.content ?? '{}')).toMatchObject({ plan: 'unlimited' });
      const pages = instance.calls().filter((call) => call.kind === 'server');
      expect(pages).toHaveLength(2);
      expect(pages.map((page) => page.spanId)).toContain(hit?.parentSpanId);
      expect(instance.health().capture).toMatchObject({ backendCalls: 1, cacheHits: 3 });
      // The chain never grows: Next sees its own marker through the layer.
      expect((globalThis.fetch as Fetch).__nextPatched).toBe(true);
    });
  }

  it('hands the global back on shutdown, with Next’s patch still working', async () => {
    const instance = create();
    const backend = await countingBackend();
    nextPatchFetch();
    await instance.shutdown();
    sdk = undefined;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    expect(descriptor && 'value' in descriptor).toBe(true);
    expect((globalThis.fetch as Fetch).__nextPatched).toBe(true);
    expect((await fetch(`${backend.url}/x`)).status).toBe(200);
    expect(backend.hits()).toBe(1);
  });

  it('ignores code that puts the layer back under itself', async () => {
    const instance = create();
    const backend = await countingBackend();
    const saved = globalThis.fetch;
    globalThis.fetch = saved; // save-and-restore, as some libraries do
    const app = await listen(async (_req, res) => json(res, 200, { status: (await fetch(`${backend.url}/y`)).status }));
    expect(await (await fetch(`${app}/api/y`)).json()).toEqual({ status: 200 });
    await instance.flush();
    expect(instance.calls().filter((call) => call.kind === 'client')).toHaveLength(1);
  });
});

describe('why nothing shows: capture counters and learned origins', () => {
  it('counts requests rejected by allowedAppOrigins, then accepts the origin the extension connected through', async () => {
    const instance = create({ allowedAppOrigins: ['https://clear-app.example.com'] });
    const backend = await countingBackend();
    const app = await listen(async (_req, res) => json(res, 200, { status: (await fetch(`${backend.url}/billing`)).status }));

    await (await fetch(`${app}/myaccount/billing`)).text();
    await instance.flush();
    expect(instance.calls()).toHaveLength(0);

    // The backend runs in this same process, so its own incoming request is counted (and rejected) too.
    const before = await health(app);
    expect(before.capture).toMatchObject({ installed: true, installedBy: 'boot', requestsSeen: 2, requestsRecorded: 0, skipped: { originNotAllowed: 2 } });
    expect(before.capture?.lastRejectedOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await (await fetch(`${app}/myaccount/billing`)).text();
    await instance.flush();
    expect(instance.calls().map((call) => call.kind)).toEqual(expect.arrayContaining(['server', 'client']));
    expect((await health(app)).capture).toMatchObject({ learnedOrigins: [app], requestsRecorded: 1, backendCalls: 1 });
  });

  it('counts requests without a session and page loads that made no backend call', async () => {
    const instance = create({ captureWithoutSession: false, autoInstrument: { ignorePaths: ['/api/check-session'] } });
    const app = await listen((_req, res) => json(res, 200, {}));
    await (await fetch(`${app}/myaccount`)).text();
    await (await fetch(`${app}/myaccount`, { headers: { 'x-qa-session-id': 'qa-1' } })).text();
    await (await fetch(`${app}/api/check-session`, { headers: { 'x-qa-session-id': 'qa-1' } })).text();
    await instance.flush();
    expect(instance.health().capture).toMatchObject({
      requestsSeen: 3, requestsRecorded: 0, skipped: { noSession: 1, noBackendCall: 1, ignoredPath: 1, originNotAllowed: 0 },
    });
  });

  it('installs itself on the first connection when register() never called install()', async () => {
    const instance = create({}, false);
    const backend = await countingBackend();
    const app = await listen(async (req, res) => {
      // The 0.2-style control route file: the only ApiLens code that runs without instrumentation.ts.
      if (req.url?.startsWith('/api/__apilens')) {
        const response = await instance.handleControlRequest(new Request(`http://${req.headers.host}${req.url}`, { headers: auth }));
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
        return;
      }
      json(res, 200, { status: (await fetch(`${backend.url}/usage`)).status });
    });

    expect(instance.health().capture?.installed).toBe(false);
    const first = (await (await fetch(`${app}/api/__apilens/health`)).json()) as ControlHealth;
    expect(first.capture?.installed).toBe(false);

    await (await fetch(`${app}/myaccount/usage`)).text();
    await instance.flush();
    expect(instance.calls().map((call) => call.kind)).toEqual(expect.arrayContaining(['server', 'client']));
    const after = instance.health();
    expect(after.capture).toMatchObject({ installed: true, installedBy: 'first-connection' });
    expect(after.configIssues?.map((issue) => issue.setting)).toContain('instrumentation');
  });
});

describe('middleware link and per-pod cursors', () => {
  it('continues the middleware run’s trace on the page it let through', async () => {
    const instance = create();
    const backend = await countingBackend();
    const app = await listen(async (_req, res) => json(res, 200, { status: (await fetch(`${backend.url}/journey`)).status }));
    const link = `${'a1'.repeat(16)}-${'b2'.repeat(8)}`;
    await (await fetch(`${app}/myaccount`, { headers: { 'x-apilens-middleware': link } })).text();
    await instance.flush();
    const page = instance.calls().find((call) => call.kind === 'server');
    const client = instance.calls().find((call) => call.kind === 'client');
    expect(page).toMatchObject({ traceId: 'a1'.repeat(16), middlewareSpanId: 'b2'.repeat(8) });
    expect(client?.traceId).toBe(page?.traceId);
    expect(client?.middlewareSpanId).toBeUndefined();
  });

  it('serves each pod its own cursor from cursors=<processId>:<seq>', async () => {
    const instance = create();
    const backend = await countingBackend();
    const app = await listen(async (_req, res) => json(res, 200, { status: (await fetch(`${backend.url}/z`)).status }));
    await (await fetch(`${app}/api/z`)).text();
    await instance.flush();
    const page = async (query: string) =>
      (await (await fetch(`${app}/api/__apilens/calls?${query}`, { headers: auth })).json()) as ControlCallsResponse;

    const all = await page(`cursors=${instance.processId}:0`);
    expect(all.calls).toHaveLength(2);
    expect((await page('cursors=someotherpod:99')).calls).toHaveLength(2);
    expect((await page(`cursors=someotherpod:1,${instance.processId}:${all.latestSeq}`)).calls).toHaveLength(0);
  });
});
