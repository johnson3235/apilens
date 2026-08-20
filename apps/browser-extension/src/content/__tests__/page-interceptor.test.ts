import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@apilens/shared-types';

describe('page interceptor', () => {
  const runtime = globalThis as typeof globalThis & Record<string, any>;
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
  let testWindow: EventTarget & Record<string, any>;
  let nativeFetch: ReturnType<typeof vi.fn>;
  let nativeXhrSend: ReturnType<typeof vi.fn>;

  const ruleFor = (path: string, action: Rule['action'], name = 'Regression mock'): Rule => ({
    id: `rule-${path}`,
    scenarioId: 'regression',
    name,
    description: 'Page interceptor regression coverage',
    enabled: true,
    priority: 1,
    conditions: [{ field: 'url', operator: 'contains', value: path }],
    conditionLogic: 'and',
    action,
    applyMode: 'always',
    appliedCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  const publishRules = (rules: Rule[], revision: string) => {
    testWindow.postMessage({ source: 'apilens-isolated-bridge', type: 'RULES_UPDATED', rules, revision }, '*');
  };

  const installGlobal = (name: string, value: unknown) => {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  beforeAll(async () => {
    class TestProgressEvent extends Event {}
    class TestCloseEvent extends Event {
      code: number;
      reason: string;
      wasClean: boolean;
      constructor(type: string, init: { code?: number; reason?: string; wasClean?: boolean } = {}) {
        super(type);
        this.code = init.code || 0;
        this.reason = init.reason || '';
        this.wasClean = Boolean(init.wasClean);
      }
    }
    class NativeXHR extends EventTarget {
      static readonly UNSENT = 0;
      static readonly OPENED = 1;
      static readonly HEADERS_RECEIVED = 2;
      static readonly LOADING = 3;
      static readonly DONE = 4;
      readyState = 0;
      status = 0;
      statusText = '';
      response: unknown = null;
      responseText = '';
      responseURL = '';
      responseXML = null;
      upload = new EventTarget();
      timeout = 0;
      withCredentials = false;
      responseType: XMLHttpRequestResponseType = '';
      open() { this.readyState = 1; this.dispatchEvent(new Event('readystatechange')); }
      setRequestHeader() {}
      overrideMimeType() {}
      getResponseHeader() { return null; }
      getAllResponseHeaders() { return ''; }
      abort() {}
      send() { nativeXhrSend(); }
    }
    class NativeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
    }
    class NativeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
    }

    nativeFetch = vi.fn(async () => new Response('{"server":true}', { status: 200 }));
    nativeXhrSend = vi.fn();
    testWindow = new EventTarget() as EventTarget & Record<string, any>;
    testWindow.fetch = nativeFetch;
    testWindow.XMLHttpRequest = NativeXHR;
    testWindow.WebSocket = NativeWebSocket;
    testWindow.EventSource = NativeEventSource;
    testWindow.setTimeout = globalThis.setTimeout.bind(globalThis);
    testWindow.clearTimeout = globalThis.clearTimeout.bind(globalThis);
    testWindow.postMessage = (data: unknown) => {
      const event = new Event('message') as Event & { data: unknown; source: unknown };
      Object.defineProperties(event, {
        data: { value: data },
        source: { value: testWindow }
      });
      testWindow.dispatchEvent(event);
    };

    installGlobal('window', testWindow);
    installGlobal('location', { href: 'https://app.example.test/checkout' });
    installGlobal('navigator', { sendBeacon: vi.fn(() => true) });
    installGlobal('ProgressEvent', TestProgressEvent);
    installGlobal('CloseEvent', TestCloseEvent);
    installGlobal('Document', class TestDocument {});

    await import('../page-interceptor');

    publishRules([
      ruleFor(
        '/api/checkout',
        { type: 'status-code', statusCode: 503, responseBody: '{"mocked":true}' },
        'Force checkout API 503'
      )
    ], 'revision-checkout');
  });

  beforeEach(() => {
    nativeFetch.mockClear();
    nativeXhrSend.mockClear();
  });

  afterAll(() => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete runtime[name];
    }
  });

  it('forces fetch to return 503 without sending the native request', async () => {
    const response = await testWindow.fetch('/api/checkout');

    expect(response.status).toBe(503);
    expect(response.statusText).toBe('Service Unavailable');
    expect(response.headers.get('x-apilens-mocked')).toBe('true');
    expect(response.headers.get('x-apilens-mocked-from')).toBe('ApiLens');
    expect(await response.json()).toEqual({ mocked: true });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('forces XMLHttpRequest to return 503 without sending the native request', async () => {
    const xhr = new testWindow.XMLHttpRequest();
    const completed = new Promise<void>((resolve, reject) => {
      xhr.onload = () => resolve();
      xhr.onerror = () => reject(new Error('The mocked XHR unexpectedly failed.'));
    });

    xhr.open('GET', '/api/checkout');
    xhr.send();
    await completed;

    expect(xhr.status).toBe(503);
    expect(xhr.statusText).toBe('Service Unavailable');
    expect(xhr.getResponseHeader('x-apilens-mocked')).toBe('true');
    expect(xhr.getResponseHeader('x-apilens-mocked-from')).toBe('ApiLens');
    expect(JSON.parse(xhr.responseText)).toEqual({ mocked: true });
    expect(nativeXhrSend).not.toHaveBeenCalled();
  });

  it('passes the in-page fetch/XHR self-test without reaching native transports', async () => {
    const requestId = crypto.randomUUID();
    const result = new Promise<any>(resolve => {
      const listener = (event: Event) => {
        const message = event as Event & { data?: any };
        if (message.data?.type === 'SELF_TEST_RESULT' && message.data.requestId === requestId) {
          testWindow.removeEventListener('message', listener);
          resolve(message.data.result);
        }
      };
      testWindow.addEventListener('message', listener);
    });

    testWindow.postMessage({ source: 'apilens-isolated-bridge', type: 'RUN_SELF_TEST', requestId }, '*');
    const selfTest = await result;

    expect(selfTest.ok, JSON.stringify(selfTest)).toBe(true);
    expect(selfTest.fetch.status).toBe(503);
    expect(selfTest.xhr.status).toBe(503);
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(nativeXhrSend).not.toHaveBeenCalled();
  });

  it('replaces a same-count rule set and reports the exact synchronized revision', async () => {
    let latestStatus: any;
    const statusListener = (event: Event) => {
      const message = event as Event & { data?: any };
      if (message.data?.type === 'INTERCEPTOR_STATUS') latestStatus = message.data.status;
    };
    testWindow.addEventListener('message', statusListener);

    publishRules([
      ruleFor('/api/profile', { type: 'status-code', statusCode: 429, responseBody: '{"limited":true}' })
    ], 'revision-profile');

    const oldEndpoint = await testWindow.fetch('/api/checkout');
    const newEndpoint = await testWindow.fetch('/api/profile');
    testWindow.removeEventListener('message', statusListener);

    expect(oldEndpoint.status).toBe(200);
    expect(newEndpoint.status).toBe(429);
    expect(newEndpoint.headers.get('x-apilens-mocked')).toBe('true');
    expect(latestStatus.rulesRevision).toBe('revision-profile');
    expect(latestStatus.ruleCount).toBe(1);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it('blocks fetch with a simulated connection failure without sending the request', async () => {
    publishRules([
      ruleFor('/api/blocked', { type: 'connection-reset' })
    ], 'revision-blocked-fetch');

    await expect(testWindow.fetch('/api/blocked')).rejects.toThrow('ApiLens simulated connection-reset');
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('blocks XMLHttpRequest with an error event without sending the request', async () => {
    publishRules([
      ruleFor('/api/blocked', { type: 'connection-reset' })
    ], 'revision-blocked-xhr');

    const xhr = new testWindow.XMLHttpRequest();
    const outcome = new Promise<string>(resolve => {
      xhr.onload = () => resolve('load');
      xhr.onerror = () => resolve('error');
    });
    xhr.open('GET', '/api/blocked');
    xhr.send();

    await expect(outcome).resolves.toBe('error');
    expect(xhr.status).toBe(0);
    expect(nativeXhrSend).not.toHaveBeenCalled();
    expect(nativeFetch).not.toHaveBeenCalled();
  });
});
