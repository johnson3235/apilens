import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK, AMBIENT_SESSION_ID } from '../index';
import type { ServerMockRule } from '../types';

const originalFetch = globalThis.fetch;
let sdk: ApiLensNextSDK | undefined;
let backend: Server | undefined;

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => (backend ? backend.close(() => resolve()) : resolve()));
  backend = undefined;
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
  return sdk;
}

async function startBackend(): Promise<string> {
  backend = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, total: { value: 12.99 } }));
  });
  await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
}

const pageHeaders = (extra: Record<string, string> = {}) =>
  new Headers({ host: 'clear-demo-dev.vercel.app', 'x-forwarded-proto': 'https', ...extra });

describe('server-rendered pages (traceRender)', () => {
  it('records the render as a page call with its backend fetches as children', async () => {
    const instance = create();
    const upstream = await startBackend();

    const data = await instance.traceRender({ path: '/myaccount/billing?contactId=3055861', headers: pageHeaders() }, async () => {
      const [a, b] = await Promise.all([
        fetch(`${upstream}/balance/3055861`).then((r) => r.json()),
        fetch(`${upstream}/billing/3055861`).then((r) => r.json()),
      ]);
      return { a, b };
    });
    await instance.flush();

    expect(data.b.total.value).toBe(12.99);
    const calls = instance.calls();
    const page = calls.find((call) => call.kind === 'server');
    const children = calls.filter((call) => call.kind === 'client');
    expect(page).toMatchObject({
      method: 'GET', path: '/myaccount/billing', origin: 'https://clear-demo-dev.vercel.app', statusCode: 200, sessionId: AMBIENT_SESSION_ID,
    });
    expect(page?.query).toHaveProperty('contactId');
    expect(page?.responseBody?.content).toContain('12.99');
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.parentSpanId === page?.spanId && child.traceId === page?.traceId)).toBe(true);
  });

  it('applies server mocks to the backend calls a page makes', async () => {
    const instance = create();
    const upstream = await startBackend();
    const now = Date.now();
    instance.setServerMockRules([{
      id: 'r1', name: 'billing down', description: '', enabled: true, priority: 1,
      match: { method: 'GET', urlPattern: '*/billing/*', matchType: 'glob', kind: 'client' },
      action: { type: 'status-code', statusCode: 503, body: '{"error":"down"}' },
      applyMode: 'once', appliedCount: 0, createdAt: now, updatedAt: now,
    } satisfies ServerMockRule]);

    const status = await instance.traceRender('/myaccount/billing', async () => (await fetch(`${upstream}/billing/1`)).status);
    await instance.flush();

    expect(status).toBe(503);
    expect(instance.calls().find((call) => call.kind === 'client')?.mockedBy).toBe('billing down');
  });

  it('records a failed render as an error and rethrows it', async () => {
    const instance = create();
    await expect(instance.traceRender('/broken', async () => { throw new TypeError('boom'); })).rejects.toThrow('boom');
    await instance.flush();
    expect(instance.calls()[0]).toMatchObject({ kind: 'server', statusCode: 500, status: 'error', error: 'TypeError' });
  });

  it("treats Next's redirect signal as a 307, and skips its internal control-flow errors", async () => {
    const instance = create();
    const signal = (digest: string) => Object.assign(new Error(digest), { digest });
    await expect(instance.traceRender('/old', () => { throw signal('NEXT_REDIRECT;replace;/new;307;'); })).rejects.toThrow();
    await expect(instance.traceRender('/static', () => { throw signal('DYNAMIC_SERVER_USAGE'); })).rejects.toThrow();
    await instance.flush();
    const calls = instance.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: '/old', statusCode: 307, status: 'ok', error: null });
  });

  it('does nothing when disabled, nested, or for a rendered element', async () => {
    const off = create({ enabled: false });
    expect(await off.traceRender('/x', () => 'plain')).toBe('plain');
    expect(off.calls()).toHaveLength(0);
    await off.shutdown();

    const instance = create();
    await instance.traceRender('/outer', () => instance.traceRender('/inner', () => ({ $$typeof: Symbol.for('react.element') })));
    await instance.flush();
    expect(instance.calls()).toHaveLength(1);
    expect(instance.calls()[0]).toMatchObject({ path: '/outer', responseBody: null });
  });

  it('never trusts a forged host header', async () => {
    const instance = create();
    await instance.traceRender({ path: '/p', headers: new Headers({ host: 'evil.example/<script>' }) }, () => null);
    await instance.flush();
    expect(instance.calls()[0]?.origin).toBe('http://localhost');
  });
});
