import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK, type ServerSpan } from '../index';
import { startAgent, type AgentHandle } from '../../../../apps/agent/src/server';

const originalFetch = globalThis.fetch;
const token = 'local-test-token-not-a-real-secret';
const origin = 'http://localhost:3000';
const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
let sdk: ApiLensNextSDK | undefined;
let agent: AgentHandle | undefined;
let backend: Server | undefined;
afterEach(async () => {
  await sdk?.shutdown(); sdk = undefined;
  globalThis.fetch = originalFetch;
  await agent?.close(); agent = undefined;
  await new Promise<void>((resolve) => backend ? backend.close(() => resolve()) : resolve()); backend = undefined;
});

async function setup() {
  agent = await startAgent({ host: '127.0.0.1', port: 0, token, dataDir: '.', outputDir: '.', maxSessions: 10, maxRequestsPerSession: 100, maxSpansPerSession: 100, autoDeleteAfterDays: 1, proxyRoutes: [], persistSessions: false }, () => undefined);
  const agentUrl = `http://127.0.0.1:${agent.port}`;
  sdk = new ApiLensNextSDK({ serviceName: 'clear-bff', enabled: true, agentToken: token, agentUrl, allowedAppOrigins: [origin] });
  return agentUrl;
}
const request = (session = 'test-session') => new Request(`${origin}/api/test?token=private-query`, { headers: { 'x-qa-session-id': session, traceparent, authorization: 'Bearer private-auth' } });
async function spans(agentUrl: string, session = 'test-session'): Promise<ServerSpan[]> {
  await sdk!.flush();
  const response = await originalFetch(`${agentUrl}/v1/sessions/${session}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return [];
  return (await response.json()).spans;
}

describe('App Router SDK → real authenticated agent', () => {
  it('records nested fetch + incoming route, keeps response/body/params and strips secrets', async () => {
    const agentUrl = await setup();
    backend = createServer((req, res) => { res.setHeader('x-correlation-id', 'backend-id'); res.setHeader('set-cookie', 'secret-cookie'); res.end(req.method === 'POST' ? 'posted' : 'ok'); });
    await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(backend.address() as AddressInfo).port}/backend?password=private-query`;
    const handler = sdk!.wrapRoute(async (_req: Request, context: { params: Promise<{ id: string }> }) => {
      expect((await context.params).id).toBe('123');
      return fetch(new Request(url, { method: 'POST', body: 'hello', headers: { authorization: 'private-downstream', 'x-request-id': 'visible-id' } }));
    });
    const response = await handler(request(), { params: Promise.resolve({ id: '123' }) });
    expect(await response.text()).toBe('posted');
    const found = await spans(agentUrl);
    expect(found).toHaveLength(2);
    const incoming = found.find((span) => span.kind === 'server')!;
    const outgoing = found.find((span) => span.kind === 'client')!;
    expect(incoming.parentSpanId).toBe('0123456789abcdef');
    expect(outgoing.parentSpanId).toBe(incoming.spanId);
    expect(outgoing.traceId).toBe(incoming.traceId);
    expect(JSON.stringify(found)).not.toMatch(/private-auth|private-downstream|private-query|secret-cookie/);
    expect(JSON.stringify(found)).toContain('visible-id');
    expect(JSON.stringify(found)).toContain('backend-id');
    expect(sdk!.diagnostics.accepted).toBe(2);
  });

  it('isolates concurrent session batches in the real agent', async () => {
    const agentUrl = await setup();
    const handler = sdk!.wrapRoute(async () => new Response('ok'));
    await Promise.all([handler(request('session-a'), undefined), handler(request('session-b'), undefined)]);
    expect((await spans(agentUrl, 'session-a')).every((span) => span.sessionId === 'session-a')).toBe(true);
    expect(await spans(agentUrl, 'session-b')).toHaveLength(1);
  });

  it('leaves non-QA requests and unapproved origins untouched', async () => {
    const agentUrl = await setup();
    const response = new Response('original');
    const handler = sdk!.wrapRoute(() => response);
    expect(await handler(new Request(`${origin}/api/test`), undefined)).toBe(response);
    expect(await handler(new Request('https://unapproved.test/api', { headers: { 'x-qa-session-id': 'test-session' } }), undefined)).toBe(response);
    expect(await spans(agentUrl)).toEqual([]);
  });

  it('rethrows application errors unchanged and reports a failed route without its secret message', async () => {
    const agentUrl = await setup();
    const failure = new Error('private-error-secret');
    await expect(sdk!.wrapRoute(() => { throw failure; })(request(), undefined)).rejects.toBe(failure);
    const found = await spans(agentUrl);
    expect(found[0].status).toBe('error');
    expect(JSON.stringify(found)).not.toContain('private-error-secret');
  });

  it('is disabled by default and rejects missing agent authentication when enabled', async () => {
    sdk = new ApiLensNextSDK({ serviceName: 'off', allowedAppOrigins: [origin] });
    sdk.installFetch();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(() => new ApiLensNextSDK({ serviceName: 'on', enabled: true, allowedAppOrigins: [origin] })).toThrow('agentToken');
  });

  it('records aborted fetch without replacing its error or blocking the app', async () => {
    const agentUrl = await setup();
    const controller = new AbortController(); controller.abort();
    const handler = sdk!.wrapRoute(async () => fetch('http://127.0.0.1:1/abort', { signal: controller.signal }));
    await expect(handler(request(), undefined)).rejects.toMatchObject({ name: 'AbortError' });
    const found = await spans(agentUrl);
    expect(found).toHaveLength(2);
    expect(found.every((span) => span.status === 'error')).toBe(true);
  });

  it('tolerates another fetch wrapper and installs idempotently without duplicate spans', async () => {
    const agentUrl = await setup();
    sdk!.installFetch();
    const firstWrapper = globalThis.fetch;
    sdk!.installFetch(); expect(globalThis.fetch).toBe(firstWrapper);
    globalThis.fetch = (input, init) => firstWrapper(input, init);
    const handler = sdk!.wrapRoute(async () => fetch('data:text/plain,hello'));
    expect(await (await handler(request(), undefined)).text()).toBe('hello');
    expect(await spans(agentUrl)).toHaveLength(2);
    await sdk!.shutdown();
    expect(await (await fetch('data:text/plain,after-shutdown')).text()).toBe('after-shutdown');
  });

  it('reports rejected agent credentials without failing the route', async () => {
    const agentUrl = await setup();
    await sdk!.shutdown();
    sdk = new ApiLensNextSDK({ serviceName: 'rejected', enabled: true, agentUrl, agentToken: 'wrong-test-token', allowedAppOrigins: [origin] });
    const response = await sdk.wrapRoute(() => new Response('still works'))(request(), undefined);
    expect(await response.text()).toBe('still works');
    await sdk.flush();
    expect(sdk.diagnostics).toMatchObject({ accepted: 0, dropped: 1, lastError: 'Agent HTTP 401' });
  });
});
