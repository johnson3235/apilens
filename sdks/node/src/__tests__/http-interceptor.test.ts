import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { enableHttpInterception, disableHttpInterception } from '../http-interceptor';
import { runWithContext } from '../context';

describe('outgoing HTTP interception', () => {
  let server: Server;
  let port: number;
  let observedHeaders: Record<string, string | string[] | undefined> = {};

  beforeAll(async () => {
    server = createServer((incoming, response) => {
      observedHeaders = incoming.headers;
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => disableHttpInterception());
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  function send(): Promise<void> {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: '127.0.0.1', port, path: '/downstream', method: 'GET' }, () => resolve());
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  it('does not add QA headers or spans outside an active QA context', async () => {
    const reporter = { addSpan: vi.fn() };
    enableHttpInterception(reporter, 'checkout-bff');
    await send();
    expect(observedHeaders['x-qa-session-id']).toBeUndefined();
    expect(reporter.addSpan).not.toHaveBeenCalled();
  });

  it('propagates session and W3C trace context and reports the child span', async () => {
    const reporter = { addSpan: vi.fn() };
    enableHttpInterception(reporter, 'checkout-bff');
    await runWithContext({
      sessionId: 'qa-session-1', scenarioId: 'payment-failure',
      traceContext: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' },
    }, send);

    expect(observedHeaders['x-qa-session-id']).toBe('qa-session-1');
    expect(observedHeaders['x-test-scenario-id']).toBe('payment-failure');
    expect(observedHeaders.traceparent).toMatch(/^00-0123456789abcdef0123456789abcdef-[a-f0-9]{16}-01$/);
    expect(reporter.addSpan).toHaveBeenCalledWith(expect.objectContaining({
      traceId: '0123456789abcdef0123456789abcdef', parentSpanId: '0123456789abcdef',
      sessionId: 'qa-session-1', serviceName: 'checkout-bff', statusCode: 204,
    }));
  });
});
