import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK } from '../index';
import { withApiLens } from '../edge';

/**
 * Next's Edge sandbox is simulated with the same globals it provides
 * (`fetch`, `crypto`, a global `AsyncLocalStorage`). The Node SDK below plays
 * the app server whose control plane receives the middleware's calls.
 */

const originalFetch = globalThis.fetch;
const token = 'edge-control-token-0123456789abcdef';
const servers: Server[] = [];
let sdk: ApiLensNextSDK | undefined;

beforeEach(() => {
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
});

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  globalThis.fetch = originalFetch;
  const shared = globalThis as Record<symbol, unknown> & { AsyncLocalStorage?: unknown };
  delete shared[Symbol.for('apilens.next.edgeFetch')];
  delete shared[Symbol.for('apilens.next.edgeStore')];
  delete shared.AsyncLocalStorage;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

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

async function setup() {
  sdk = new ApiLensNextSDK({
    serviceName: 'clear-bff', enabled: true, reportToAgent: false, allowedAppOrigins: ['*'], captureWithoutSession: true,
    control: { enabled: true, token },
  });
  sdk.install();
  const app = await listen((_req, res) => json(res, 404, {}));
  const authBff = await listen((req, res) => json(res, req.url === '/session' ? 200 : 401, { sessionId: 's-1', msisdn: '353871234567' }));
  return { app, authBff, instance: sdk };
}

/** A NextFetchEvent stand-in: collects waitUntil promises. */
function fetchEvent() {
  const pending: Promise<unknown>[] = [];
  return { event: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } }, settle: () => Promise.all(pending) };
}

describe('Edge middleware capture', () => {
  it('delivers the middleware run and its backend calls to the control plane', async () => {
    const { app, authBff, instance } = await setup();
    const middleware = withApiLens(async (request: Request) => {
      const session = await fetch(`${authBff}/session`, { headers: { cookie: 'sid=secret' } });
      if (!session.ok) return Response.redirect(new URL('/error', request.url), 307);
      return new Response(null, { status: 200, headers: { 'x-middleware-next': '1' } });
    }, { enabled: true, controlToken: token, captureWithoutSession: true, serviceName: 'clear-middleware' });

    const { event, settle } = fetchEvent();
    const response = await middleware(new Request(`${app}/myaccount/billing`), event);
    expect(response.status).toBe(200);
    await settle();

    const calls = instance.calls();
    const run = calls.find((call) => call.kind === 'server');
    const client = calls.find((call) => call.kind === 'client');
    expect(run).toMatchObject({ serviceName: 'clear-middleware', path: '/myaccount/billing', statusCode: 200 });
    expect(client).toMatchObject({ path: '/session', statusCode: 200, parentSpanId: run?.spanId, traceId: run?.traceId });
    expect(client?.requestHeaders.cookie).toBe('[REDACTED]');
    expect(JSON.parse(client?.responseBody?.content ?? '{}')).toMatchObject({ sessionId: 's-1', msisdn: '[REDACTED]' });
  });

  it('records redirects even when no backend call was made', async () => {
    const { app, instance } = await setup();
    const middleware = withApiLens((request: Request) => Response.redirect(new URL('/login', request.url), 307),
      { enabled: true, controlToken: token, captureWithoutSession: true });
    const { event, settle } = fetchEvent();
    await middleware(new Request(`${app}/myaccount`), event);
    await settle();
    expect(instance.calls()).toEqual([expect.objectContaining({ kind: 'server', statusCode: 307, path: '/myaccount' })]);
  });

  it('is a no-op when disabled, without a valid token, or with no session', async () => {
    const { app, authBff, instance } = await setup();
    const handler = async () => { await fetch(`${authBff}/session`); return new Response('ok'); };
    expect(withApiLens(handler, { enabled: false, controlToken: token })).toBe(handler);
    expect(withApiLens(handler, { enabled: true, controlToken: 'short' })).toBe(handler);

    const sessionOnly = withApiLens(handler, { enabled: true, controlToken: token });
    const { event, settle } = fetchEvent();
    await sessionOnly(new Request(`${app}/myaccount`), event);
    await settle();
    expect(instance.calls()).toHaveLength(0);
  });

  it('never fails the request when delivery fails', async () => {
    const { app, authBff } = await setup();
    const middleware = withApiLens(async () => { await fetch(`${authBff}/session`); return new Response('ok'); },
      { enabled: true, controlToken: token, captureWithoutSession: true, ingestUrl: 'http://127.0.0.1:1/api/__apilens' });
    const { event, settle } = fetchEvent();
    expect(await (await middleware(new Request(`${app}/x`), event)).text()).toBe('ok');
    await expect(settle()).resolves.toBeDefined();
  });

  it('links the page the middleware let through, so the extension can nest the run under it', async () => {
    const { app, authBff, instance } = await setup();
    const options = { enabled: true, controlToken: token, captureWithoutSession: true };
    const checked = withApiLens(async () => {
      await fetch(`${authBff}/session`);
      return new Response(null, { headers: { 'x-middleware-next': '1' } });
    }, options);
    const { event, settle } = fetchEvent();
    const response = await checked(new Request(`${app}/myaccount/billing`, { headers: { cookie: 'sid=1', 'x-qa-session-id': 'qa-7' } }), event);
    await settle();

    const run = instance.calls().find((call) => call.kind === 'server');
    expect(run?.stage).toBe('middleware');
    expect(instance.calls().every((call) => call.stage === 'middleware')).toBe(true);
    // Next forwards exactly the listed headers, so the incoming ones must stay listed next to the link.
    const forwarded = response.headers.get('x-middleware-override-headers')?.split(',') ?? [];
    expect(forwarded).toEqual(expect.arrayContaining(['cookie', 'x-qa-session-id', 'x-apilens-middleware']));
    expect(response.headers.get('x-middleware-request-cookie')).toBe('sid=1');
    expect(response.headers.get('x-middleware-request-x-apilens-middleware')).toBe(`${run?.traceId}-${run?.spanId}`);
    expect(instance.health().capture?.middlewareRuns).toBe(1);
  });

  it('extends an override list the middleware set itself, and treats returning nothing as next()', async () => {
    const { app, authBff } = await setup();
    const options = { enabled: true, controlToken: token, captureWithoutSession: true };
    const own = withApiLens(async () => {
      await fetch(`${authBff}/session`);
      return new Response(null, { headers: { 'x-middleware-next': '1', 'x-middleware-override-headers': 'x-journey', 'x-middleware-request-x-journey': 'payg' } });
    }, options);
    const silent = withApiLens(async () => { await fetch(`${authBff}/session`); }, options);
    const { event, settle } = fetchEvent();

    const extended = await own(new Request(`${app}/a`, { headers: { cookie: 'sid=1' } }), event);
    expect(extended.headers.get('x-middleware-override-headers')).toBe('x-journey,x-apilens-middleware');
    expect(extended.headers.get('x-middleware-request-cookie')).toBeNull();

    const continued = (await silent(new Request(`${app}/b`), event)) as Response | undefined;
    expect(continued?.headers.get('x-middleware-next')).toBe('1');
    expect(continued?.headers.get('x-middleware-request-x-apilens-middleware')).toMatch(/^[a-f0-9]{32}-[a-f0-9]{16}$/);
    await settle();
  });

  it('leaves redirects and runs without backend calls untouched', async () => {
    const { app, authBff } = await setup();
    const options = { enabled: true, controlToken: token, captureWithoutSession: true };
    const redirecting = withApiLens(async (request: Request) => {
      await fetch(`${authBff}/session`);
      return Response.redirect(new URL('/login', request.url), 307);
    }, options);
    const idle = withApiLens(() => new Response(null, { headers: { 'x-middleware-next': '1' } }), options);
    const { event, settle } = fetchEvent();
    expect((await redirecting(new Request(`${app}/a`), event)).headers.get('location')).toMatch(/\/login$/);
    expect((await idle(new Request(`${app}/b`), event)).headers.get('x-middleware-override-headers')).toBeNull();
    await settle();
  });
});

