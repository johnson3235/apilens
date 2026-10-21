import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiLensNextSDK } from '../index';
// Deliberately reaches into the extension source: this test exists to prove the
// two independently-versioned halves still speak the same protocol.
import { ServerControlClient, serverRuleFromCall } from '../../../../apps/browser-extension/src/shared/server-control';

const controlToken = 'e2e-control-token-not-a-real-secret';
const appOrigin = 'http://127.0.0.1';

let sdk: ApiLensNextSDK | undefined;
let app: Server | undefined;
let upstream: Server | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  globalThis.fetch = originalFetch;
  for (const server of [app, upstream]) {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
  app = undefined;
  upstream = undefined;
});

/** Minimal Node-to-Fetch adapter so the SDK handler runs behind a real socket. */
function toRequest(message: IncomingMessage, origin: string, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(', '));
  }
  const method = message.method ?? 'GET';
  return new Request(`${origin}${message.url ?? '/'}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

async function send(response: ServerResponse, result: Response): Promise<void> {
  const payload = Buffer.from(await result.arrayBuffer());
  const headers: Record<string, string> = {};
  result.headers.forEach((value, name) => {
    headers[name] = value;
  });
  response.writeHead(result.status, { ...headers, 'content-length': payload.byteLength });
  response.end(payload);
}

async function readBody(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('extension ↔ server SDK over real HTTP', () => {
  it('streams captured payloads to the extension client and applies a pushed mock', async () => {
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ balance: { amountDue: 42.5, currency: 'EUR' }, contactId: '3055861' }));
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/billing`;

    sdk = new ApiLensNextSDK({
      serviceName: 'clear-app-bff',
      enabled: true,
      reportToAgent: false,
      allowedAppOrigins: ['*'],
      captureWithoutSession: true,
      control: { enabled: true, token: controlToken },
    });

    const billing = sdk.wrapRoute(async () => {
      const response = await fetch(upstreamUrl);
      return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } });
    });

    app = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const origin = `${appOrigin}:${(app!.address() as AddressInfo).port}`;
        const incoming = toRequest(request, origin, body);
        if (incoming.url.includes('/api/__apilens/')) {
          await send(response, await sdk!.handleControlRequest(incoming));
          return;
        }
        await send(response, await billing(incoming, undefined));
      })();
    });
    await new Promise<void>((resolve) => app!.listen(0, '127.0.0.1', resolve));
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

    const client = new ServerControlClient({ url: `${appUrl}/api/__apilens`, token: controlToken });

    const health = await client.health();
    expect(health.serviceName).toBe('clear-app-bff');
    expect(health.protocolVersion).toBe(2);

    // 1. Real traffic produces visible payloads.
    const real = await originalFetch(`${appUrl}/api/billing?contactId=3055861`);
    expect((await real.json()).balance.amountDue).toBe(42.5);
    await sdk.flush();

    const page = await client.calls(0);
    expect(page.calls.length).toBe(2);
    const outbound = page.calls.find((entry) => entry.kind === 'client')!;
    expect(outbound.responseBody?.content).toContain('42.5');
    const inbound = page.calls.find((entry) => entry.kind === 'server')!;
    expect(inbound.query.contactId).toBe('3055861');
    expect(inbound.responseBody?.content).toContain('EUR');

    // 2. A rule built from that call, pushed by the extension, takes effect.
    const rule = { ...serverRuleFromCall(outbound), enabled: true };
    const saved = await client.setRules([rule]);
    expect(saved.rules[0]!.enabled).toBe(true);

    const mocked = await originalFetch(`${appUrl}/api/billing`);
    expect(mocked.status).toBe(503);
    await sdk.flush();

    // 3. The mocked call is reported back as mocked, with an incremental cursor.
    const next = await client.calls(page.latestSeq);
    const mockedCall = next.calls.find((entry) => entry.mockedBy);
    expect(mockedCall?.mockedBy).toBe(rule.name);
    expect(mockedCall?.statusCode).toBe(503);

    // 4. Clearing from the extension empties the server buffer.
    await client.clearCalls();
    expect((await client.calls(0)).calls).toHaveLength(0);
  });

  it('rejects a wrong token over the wire without leaking whether the route exists', async () => {
    sdk = new ApiLensNextSDK({
      serviceName: 'clear-app-bff',
      enabled: true,
      reportToAgent: false,
      allowedAppOrigins: ['*'],
      control: { enabled: true, token: controlToken },
    });

    app = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const origin = `${appOrigin}:${(app!.address() as AddressInfo).port}`;
        await send(response, await sdk!.handleControlRequest(toRequest(request, origin, body)));
      })();
    });
    await new Promise<void>((resolve) => app!.listen(0, '127.0.0.1', resolve));
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

    const wrong = new ServerControlClient({ url: `${appUrl}/api/__apilens`, token: 'definitely-the-wrong-token-value' });
    await expect(wrong.health()).rejects.toThrow('Control token rejected');
  });
});
