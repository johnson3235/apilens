import { afterEach, describe, expect, it, vi } from 'vitest';

const savedConsoleError = console.error;
afterEach(() => { console.error = savedConsoleError; vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); });

describe('actual page hook propagation', () => {
  it('passes same-origin headers to native fetch, but not cross-origin or disabled calls', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event: unknown) => void>();
    const nativeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    class NativeXHR {}
    class NativeSocket {}
    const page = {
      fetch: nativeFetch, XMLHttpRequest: NativeXHR, WebSocket: NativeSocket, EventSource: NativeSocket,
      postMessage: vi.fn(), addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
      removeEventListener: vi.fn(), setInterval, clearInterval, setTimeout, clearTimeout,
    };
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', { origin: 'http://localhost:3000', href: 'http://localhost:3000/' });
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) });
    await import('./page-interceptor');
    const sendSettings = (enabled: boolean) => listeners.get('message')!({ source: page, data: { source: 'apilens-bridge', type: 'settings', captureBodies: false,
      trace: { enabled, sessionId: 'active-qa', scenarioId: null, origin: 'http://localhost:3000' } } });
    sendSettings(true);
    await page.fetch('/api/products');
    expect(nativeFetch).toHaveBeenLastCalledWith('/api/products', expect.objectContaining({ headers: expect.objectContaining({ 'x-qa-session-id': 'active-qa', traceparent: expect.stringMatching(/^00-/) }) }));
    await page.fetch('https://untrusted.test/api');
    expect(nativeFetch).toHaveBeenLastCalledWith('https://untrusted.test/api', undefined);
    sendSettings(false);
    await page.fetch('/api/products');
    expect(nativeFetch).toHaveBeenLastCalledWith('/api/products', undefined);
  });
});
