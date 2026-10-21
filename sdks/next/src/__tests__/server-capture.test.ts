import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK, AMBIENT_SESSION_ID } from '../index';
import type { ControlCallsResponse, ControlHealth, ServerMockRule } from '../types';

const origin = 'http://localhost:3000';
const controlToken = 'control-token-for-local-tests-only';
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
    allowedAppOrigins: [origin],
    control: { enabled: true, token: controlToken },
    ...overrides,
  });
  return sdk;
}

async function startBackend(handler: (method: string, url: string) => { status?: number; body: string; type?: string }): Promise<string> {
  backend = createServer((req, res) => {
    const result = handler(req.method ?? 'GET', req.url ?? '/');
    res.writeHead(result.status ?? 200, { 'content-type': result.type ?? 'application/json' });
    res.end(result.body);
  });
  await new Promise<void>((resolve) => backend!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
}

const qaRequest = (path = '/api/billing', init: RequestInit = {}) =>
  new Request(`${origin}${path}`, { headers: { 'x-qa-session-id': 'qa-1' }, ...init });

const control = (instance: ApiLensNextSDK, path: string, init: RequestInit = {}) =>
  instance.handleControlRequest(
    new Request(`${origin}/api/__apilens/${path}`, { headers: { authorization: `Bearer ${controlToken}` }, ...init }),
  );

describe('server-side payload capture', () => {
  it('captures request and response bodies for an incoming route and its outgoing fetch', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: JSON.stringify({ balance: 42, currency: 'EUR' }) }));

    const handler = instance.wrapRoute(async (request: Request) => {
      const payload = await request.json();
      const response = await fetch(`${upstream}/billing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forwarded: payload.contactId }),
      });
      return new Response(await response.text(), { headers: { 'content-type': 'application/json' } });
    });

    const result = await handler(
      qaRequest('/api/billing', { method: 'POST', headers: { 'content-type': 'application/json', 'x-qa-session-id': 'qa-1' }, body: JSON.stringify({ contactId: '3055861' }) }),
      undefined,
    );
    expect(JSON.parse(await result.text()).balance).toBe(42);
    await instance.flush();

    const calls = instance.calls();
    expect(calls).toHaveLength(2);

    const incoming = calls.find((call) => call.kind === 'server')!;
    expect(incoming.requestBody?.content).toContain('3055861');
    expect(incoming.responseBody?.content).toContain('42');

    const outgoing = calls.find((call) => call.kind === 'client')!;
    expect(outgoing.requestBody?.content).toContain('3055861');
    expect(outgoing.responseBody?.content).toContain('EUR');
    expect(outgoing.statusCode).toBe(200);
  });

  it('redacts secrets inside payloads and never buffers them', async () => {
    const instance = create({ captureBodies: { redactKeys: ['contactRef'] } });
    const upstream = await startBackend(() => ({
      body: JSON.stringify({ accessToken: 'super-secret-value', card: { cardNumber: '4111111111111111' }, safe: 'visible' }),
    }));

    const handler = instance.wrapRoute(async () => fetch(`${upstream}/token`));
    await handler(
      qaRequest('/api/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-qa-session-id': 'qa-1' },
        body: JSON.stringify({ password: 'hunter2', contactRef: 'private-ref', keep: 'kept' }),
      }),
      undefined,
    );
    await instance.flush();

    const serialised = JSON.stringify(instance.calls());
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('private-ref');
    expect(serialised).not.toContain('super-secret-value');
    expect(serialised).not.toContain('4111111111111111');
    expect(serialised).toContain('kept');
    expect(serialised).toContain('visible');
  });

  it('truncates payloads beyond the cap and reports it instead of dropping them', async () => {
    const instance = create({ captureBodies: { maxBytes: 64 } });
    const upstream = await startBackend(() => ({ body: JSON.stringify({ blob: 'x'.repeat(5_000) }) }));
    const handler = instance.wrapRoute(async () => fetch(`${upstream}/large`));

    await handler(qaRequest('/api/large'), undefined);
    await instance.flush();

    const outgoing = instance.calls().find((call) => call.kind === 'client')!;
    expect(outgoing.responseBody?.truncated).toBe(true);
    expect(outgoing.responseBody?.byteLength).toBe(64);
  });

  it('explains why a binary payload was not captured', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: 'PDFDATA', type: 'application/pdf' }));
    const handler = instance.wrapRoute(async () => fetch(`${upstream}/statement.pdf`));

    await handler(qaRequest('/api/statement'), undefined);
    await instance.flush();

    const outgoing = instance.calls().find((call) => call.kind === 'client')!;
    expect(outgoing.responseBody).toBeNull();
    expect(outgoing.responseBodyOmitted).toContain('application/pdf');
  });

  it('captures shared dev traffic that carries no QA session header', async () => {
    const instance = create({ captureWithoutSession: true });
    const handler = instance.wrapRoute(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));

    await handler(new Request(`${origin}/api/anonymous`), undefined);
    await instance.flush();

    expect(instance.calls()[0]?.sessionId).toBe(AMBIENT_SESSION_ID);
  });

  it('keeps ignoring unapproved origins unless a wildcard is configured', async () => {
    const instance = create({ captureWithoutSession: true });
    const handler = instance.wrapRoute(async () => new Response('ok'));
    await handler(new Request('https://elsewhere.test/api/x'), undefined);
    await instance.flush();
    expect(instance.calls()).toHaveLength(0);

    await instance.shutdown();
    const wildcard = create({ captureWithoutSession: true, allowedAppOrigins: ['*'] });
    await wildcard.wrapRoute(async () => new Response('ok'))(new Request('https://elsewhere.test/api/x'), undefined);
    await wildcard.flush();
    expect(wildcard.calls()).toHaveLength(1);
  });
});

describe('server-side mocking', () => {
  const rule = (overrides: Partial<ServerMockRule> = {}): ServerMockRule => ({
    id: 'rule-1',
    name: 'Billing 503',
    description: '',
    enabled: true,
    priority: 10,
    match: { method: 'ANY', urlPattern: '*/billing*', matchType: 'glob', kind: 'client' },
    action: { type: 'status-code', statusCode: 503, body: '{"error":"unavailable"}' },
    applyMode: 'always',
    appliedCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  it('short-circuits an outgoing fetch and marks the call as mocked', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: '{"real":true}' }));
    instance.setServerMockRules([rule()]);

    const handler = instance.wrapRoute(async () => {
      const response = await fetch(`${upstream}/billing`);
      return new Response(await response.text(), { status: response.status });
    });

    const result = await handler(qaRequest(), undefined);
    expect(result.status).toBe(503);
    expect(await result.text()).toContain('unavailable');
    await instance.flush();

    const mocked = instance.calls().find((call) => call.kind === 'client')!;
    expect(mocked.mockedBy).toBe('Billing 503');
    expect(mocked.statusCode).toBe(503);
  });

  it('simulates a transport failure the application can catch', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: '{}' }));
    instance.setServerMockRules([rule({ action: { type: 'network-error' } })]);

    const handler = instance.wrapRoute(async () => {
      try {
        await fetch(`${upstream}/billing`);
        return new Response('unexpected-success', { status: 200 });
      } catch {
        return new Response('handled-upstream-failure', { status: 502 });
      }
    });

    const result = await handler(qaRequest(), undefined);
    expect(result.status).toBe(502);
    expect(await result.text()).toBe('handled-upstream-failure');
  });

  it('mutates a real upstream payload for passthrough rules', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: JSON.stringify({ data: { amountDue: 25.5, label: 'Bill' } }) }));
    instance.setServerMockRules([
      rule({
        action: {
          type: 'passthrough-mutate',
          fieldMutations: [
            { path: 'data.amountDue', operation: 'nullify' },
            { path: 'data.label', operation: 'delete' },
          ],
        },
      }),
    ]);

    const handler = instance.wrapRoute(async () => {
      const response = await fetch(`${upstream}/billing`);
      return new Response(await response.text(), { status: response.status });
    });

    const payload = JSON.parse(await (await handler(qaRequest(), undefined)).text());
    expect(payload.data.amountDue).toBeNull();
    expect(payload.data).not.toHaveProperty('label');
  });

  it('respects apply budgets and rule scope', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: '{"real":true}' }));
    instance.setServerMockRules([rule({ applyMode: 'once' })]);

    const handler = instance.wrapRoute(async () => {
      const first = await fetch(`${upstream}/billing`);
      const second = await fetch(`${upstream}/billing`);
      return new Response(JSON.stringify([first.status, second.status]));
    });

    expect(JSON.parse(await (await handler(qaRequest(), undefined)).text())).toEqual([503, 200]);
  });

  it('leaves incoming routes alone unless route mocks are explicitly allowed', async () => {
    const instance = create();
    const serverRule = rule({ match: { method: 'ANY', urlPattern: '*/api/billing*', matchType: 'glob', kind: 'server' } });
    instance.setServerMockRules([serverRule]);

    const handler = instance.wrapRoute(async () => new Response('real-handler'));
    expect(await (await handler(qaRequest(), undefined)).text()).toBe('real-handler');

    await instance.shutdown();
    const permissive = create({ allowRouteMocks: true });
    permissive.setServerMockRules([serverRule]);
    const mockedHandler = permissive.wrapRoute(async () => new Response('real-handler'));
    const response = await mockedHandler(qaRequest(), undefined);
    expect(response.status).toBe(503);
  });

  it('rejects malformed rules instead of trusting control-plane input', () => {
    const instance = create();
    const accepted = instance.setServerMockRules([
      { id: 'ok', name: 'Fine', match: { urlPattern: '*/x' }, action: { type: 'status-code', statusCode: 99_999 } },
      { name: 'no id' },
      'not an object',
    ]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.action.statusCode).toBe(599);
    expect(accepted[0]!.enabled).toBe(false);
  });

  it('survives non-ASCII rule names, which cannot be written to a header', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: '{"real":true}' }));
    instance.setServerMockRules([rule({ name: 'GET /billing → 503 · émoji ✓' })]);

    // Returns the upstream response unchanged so mock headers stay visible.
    const handler = instance.wrapRoute(async () => fetch(`${upstream}/billing`));

    const result = await handler(qaRequest(), undefined);
    expect(result.status).toBe(503);
    expect(result.headers.get('x-apilens-mock')).toMatch(/^GET \/billing \? 503/);
  });

  it('drops a header name the platform rejects rather than failing the call', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: '{"real":true}' }));
    instance.setServerMockRules([
      rule({ action: { type: 'status-code', statusCode: 500, headers: { 'bad header name': 'x', 'x-good': 'kept' } } }),
    ]);

    const handler = instance.wrapRoute(async () => fetch(`${upstream}/billing`));
    const result = await handler(qaRequest(), undefined);
    expect(result.status).toBe(500);
    expect(result.headers.get('x-good')).toBe('kept');
  });

  it('propagates a caller abort during a simulated delay', async () => {
    const instance = create();
    const upstream = await startBackend(() => ({ body: '{"real":true}' }));
    instance.setServerMockRules([rule({ action: { type: 'status-code', statusCode: 503, delayMs: 5_000 } })]);

    const controller = new AbortController();
    const handler = instance.wrapRoute(async () => fetch(`${upstream}/billing`, { signal: controller.signal }));
    const pending = handler(qaRequest(), undefined);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('control plane', () => {
  it('refuses unauthenticated access and hides itself when disabled', async () => {
    const instance = create();
    const anonymous = await instance.handleControlRequest(new Request(`${origin}/api/__apilens/health`));
    expect(anonymous.status).toBe(401);

    const wrongToken = await instance.handleControlRequest(
      new Request(`${origin}/api/__apilens/health`, { headers: { authorization: 'Bearer wrong-token-value-1234567890' } }),
    );
    expect(wrongToken.status).toBe(401);

    await instance.shutdown();
    const disabled = create({ control: undefined });
    expect((await disabled.handleControlRequest(new Request(`${origin}/api/__apilens/health`))).status).toBe(404);
  });

  it('rejects a control token that is too weak or reuses the agent token', () => {
    expect(() => new ApiLensNextSDK({ serviceName: 's', enabled: true, reportToAgent: false, allowedAppOrigins: [origin], control: { enabled: true, token: 'short' } })).toThrow('at least 24');
    expect(
      () =>
        new ApiLensNextSDK({
          serviceName: 's',
          enabled: true,
          agentToken: controlToken,
          allowedAppOrigins: [origin],
          control: { enabled: true, token: controlToken },
        }),
    ).toThrow('must differ from agentToken');
  });

  it('reports health and serves calls incrementally by cursor', async () => {
    const instance = create();
    const health = (await (await control(instance, 'health')).json()) as ControlHealth;
    expect(health.serviceName).toBe('clear-bff');
    expect(health.captureRequestBodies).toBe(true);

    const handler = instance.wrapRoute(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    await handler(qaRequest('/api/one'), undefined);
    await instance.flush();

    const first = (await (await control(instance, 'calls?since=0')).json()) as ControlCallsResponse;
    expect(first.calls).toHaveLength(1);
    expect(first.gap).toBe(false);

    await handler(qaRequest('/api/two'), undefined);
    await instance.flush();

    const next = (await (await control(instance, `calls?since=${first.latestSeq}`)).json()) as ControlCallsResponse;
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]!.path).toBe('/api/two');
  });

  it('accepts and returns mock rules pushed by the extension', async () => {
    const instance = create();
    const response = await control(instance, 'rules', {
      method: 'PUT',
      headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'r1', name: 'Slow billing', enabled: true, match: { urlPattern: '*/billing' }, action: { type: 'status-code', statusCode: 500 } }] }),
    });
    expect(response.status).toBe(200);

    const stored = (await (await control(instance, 'rules')).json()) as { rules: ServerMockRule[] };
    expect(stored.rules).toHaveLength(1);
    expect(stored.rules[0]!.name).toBe('Slow billing');
    expect(instance.serverMockRules()[0]!.enabled).toBe(true);
  });

  it('clears the buffer on request', async () => {
    const instance = create();
    await instance.wrapRoute(async () => new Response('ok'))(qaRequest(), undefined);
    await instance.flush();
    expect(instance.calls().length).toBeGreaterThan(0);

    await control(instance, 'calls', { method: 'DELETE', headers: { authorization: `Bearer ${controlToken}` } });
    expect(instance.calls()).toHaveLength(0);
  });

  it('never exposes captured traffic to an unlisted browser origin', async () => {
    const instance = create();
    const response = await instance.handleControlRequest(
      new Request(`${origin}/api/__apilens/health`, {
        headers: { authorization: `Bearer ${controlToken}`, origin: 'https://evil.test' },
      }),
    );
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });
});
