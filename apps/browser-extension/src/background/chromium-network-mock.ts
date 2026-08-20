import type { CapturedRequest, Rule } from '@apilens/shared-types';
import { extensionApi as api } from '../shared/browser-api';
import { decideNetworkMock } from '../shared/network-mock-core';

type DebuggerApi = typeof chrome.debugger;
type MockRecorder = (tabId: number, request: CapturedRequest, rule: Rule, networkRequestId?: string) => void | Promise<void>;

interface NetworkMockState {
  active: boolean;
  error: string | null;
}

function encodeBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function statusText(statusCode: number) {
  return ({
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    408: 'Request Timeout', 409: 'Conflict', 422: 'Unprocessable Content', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
  } as Record<number, string>)[statusCode] || '';
}

function safeResponseHeaders(headers: Record<string, string>) {
  return Object.entries(headers)
    .filter(([name, value]) => Boolean(name) && !/[\r\n]/.test(name) && !/[\r\n]/.test(String(value)))
    .map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * Chromium-only fallback for pages whose CSP or script hardening prevents the
 * page-world hook from being installed. The Fetch protocol fulfills matching
 * Fetch/XHR requests at the browser network boundary, so the application and
 * the native Network panel receive the forced status/body.
 */
export class ChromiumNetworkMock {
  private readonly debuggerApi: DebuggerApi | undefined;
  private readonly states = new Map<number, NetworkMockState>();
  private readonly detachingTabs = new Set<number>();

  constructor(
    private readonly getRules: () => Rule[],
    private readonly recordMock: MockRecorder
  ) {
    this.debuggerApi = (api as typeof chrome & { debugger?: DebuggerApi }).debugger;
    this.debuggerApi?.onEvent.addListener((source, method, params) => {
      if (method === 'Fetch.requestPaused' && source.tabId) {
        void this.handleRequestPaused(source.tabId, params as Record<string, any>);
      }
    });
    this.debuggerApi?.onDetach.addListener((source, reason) => {
      if (!source.tabId) return;
      if (this.detachingTabs.delete(source.tabId) || reason === 'target_closed') {
        this.states.delete(source.tabId);
        return;
      }
      this.states.set(source.tabId, {
        active: false,
        error: `The browser detached the network mock engine (${reason}). Use Repair now to reconnect it.`
      });
    });
  }

  supported() {
    return Boolean(this.debuggerApi?.attach && this.debuggerApi?.sendCommand);
  }

  isActive(tabId: number) {
    return this.states.get(tabId)?.active === true;
  }

  error(tabId: number) {
    return this.states.get(tabId)?.error || null;
  }

  async enable(tabId: number) {
    if (!this.debuggerApi) return { active: false, error: 'The network mock fallback is not available in this browser.' };
    if (this.isActive(tabId)) return { active: true, error: null };

    try {
      await this.debuggerApi.attach({ tabId }, '1.3');
      await this.debuggerApi.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [
          { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' }
        ]
      });
      this.states.set(tabId, { active: true, error: null });
      return { active: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.states.set(tabId, { active: false, error: message });
      try { await this.debuggerApi.detach({ tabId }); } catch (_) { /* It may not have attached. */ }
      return { active: false, error: message };
    }
  }

  async disable(tabId: number) {
    if (!this.debuggerApi || !this.states.has(tabId)) return;
    this.states.delete(tabId);
    try { await this.debuggerApi.sendCommand({ tabId }, 'Fetch.disable'); } catch (_) { /* Already detached. */ }
    this.detachingTabs.add(tabId);
    try { await this.debuggerApi.detach({ tabId }); } catch (_) { this.detachingTabs.delete(tabId); /* Already detached. */ }
  }

  async selfTest(tabId: number) {
    const enabled = await this.enable(tabId);
    if (!enabled.active) return { ok: false, engine: 'chromium-network', error: enabled.error || 'Unable to enable the network mock engine.' };

    const marker = `__apilens_network_self_test_${crypto.randomUUID().replaceAll('-', '')}`;
    try {
      const results = await api.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: async (path: string) => {
          const response = await fetch(new URL(path, location.origin).href, { cache: 'no-store' });
          return {
            status: response.status,
            mockedHeader: response.headers.get('x-apilens-mocked'),
            body: await response.text()
          };
        },
        args: [marker]
      });
      const result = results.find(item => item.frameId === 0)?.result as { status?: number; mockedHeader?: string | null; body?: string } | undefined;
      const ok = result?.status === 503 && result.mockedHeader === 'true' && result.body?.includes('"selfTest":true');
      return {
        ok: Boolean(ok),
        engine: 'chromium-network',
        fetch: { status: result?.status, mockedHeader: result?.mockedHeader },
        testedAt: Date.now(),
        error: ok ? undefined : 'The Chromium network mock self-test did not receive the forced 503 response.'
      };
    } catch (error) {
      return { ok: false, engine: 'chromium-network', testedAt: Date.now(), error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async handleRequestPaused(tabId: number, params: Record<string, any>) {
    if (!this.isActive(tabId) || !this.debuggerApi || !params.requestId) return;
    const request = this.toCapturedRequest(params);
    if (!request) {
      await this.continueRequest(tabId, params.requestId);
      return;
    }

    // The self-test is intentionally handled in the network engine rather
    // than depending on any page-world hook.
    if (request.url.includes('__apilens_network_self_test_')) {
      await this.fulfill(tabId, params.requestId, 503, '{"mockedBy":"ApiLens","selfTest":true}', {
        'content-type': 'application/json',
        'x-apilens-mocked': 'true',
        'x-apilens-mocked-from': 'ApiLens',
        'x-apilens-transport': 'chromium-network'
      });
      return;
    }

    const decision = decideNetworkMock(this.getRules(), request);
    if (decision.kind === 'continue') {
      await this.continueRequest(tabId, params.requestId);
      return;
    }

    try {
      if (decision.kind === 'fail') {
        request.scenarioApplied = decision.rule.name;
        request.error = `ApiLens simulated ${decision.errorReason}`;
        request.completedAt = Date.now();
        request.durationMs = request.completedAt - request.startedAt;
        await this.debuggerApi.sendCommand({ tabId }, 'Fetch.failRequest', {
          requestId: params.requestId,
          errorReason: decision.errorReason
        });
        await this.recordMock(tabId, request, decision.rule, params.networkId || params.requestId);
        return;
      }

      if (decision.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, decision.delayMs));
      }
      await this.fulfill(tabId, params.requestId, decision.statusCode, decision.body, decision.headers);
      request.statusCode = decision.statusCode;
      request.responseHeaders = Object.fromEntries(Object.entries(decision.headers).map(([name, value]) => [name.toLowerCase(), value]));
      request.responseBody = decision.body;
      request.scenarioApplied = decision.rule.name;
      request.completedAt = Date.now();
      request.durationMs = request.completedAt - request.startedAt;
      await this.recordMock(tabId, request, decision.rule, params.networkId || params.requestId);
    } catch (error) {
      // A paused request must always be released when fulfillment fails.
      console.error('ApiLens could not fulfill a network mock:', error);
      await this.continueRequest(tabId, params.requestId);
    }
  }

  private async fulfill(tabId: number, requestId: string, statusCode: number, body: string, headers: Record<string, string>) {
    if (!this.debuggerApi) return;
    await this.debuggerApi.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
      requestId,
      responseCode: statusCode,
      responsePhrase: statusText(statusCode),
      responseHeaders: safeResponseHeaders(headers),
      body: encodeBase64(body)
    });
  }

  private async continueRequest(tabId: number, requestId: string) {
    try { await this.debuggerApi?.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId }); } catch (_) { /* Navigation can cancel a paused request. */ }
  }

  private toCapturedRequest(params: Record<string, any>): CapturedRequest | null {
    const raw = params.request as { url?: string; method?: string; headers?: Record<string, string>; postData?: string } | undefined;
    if (!raw?.url) return null;
    try {
      const url = new URL(raw.url);
      const queryParams: Record<string, string> = {};
      url.searchParams.forEach((value, key) => { queryParams[key] = value; });
      const requestHeaders: Record<string, string> = {};
      Object.entries(raw.headers || {}).forEach(([name, value]) => { requestHeaders[name.toLowerCase()] = String(value); });
      return {
        id: `network-${params.networkId || params.requestId}`,
        sessionId: '', source: 'browser', type: 'fetch', method: String(raw.method || 'GET').toUpperCase() as CapturedRequest['method'],
        url: url.href, path: url.pathname, hostname: url.hostname, queryParams, requestHeaders, responseHeaders: {},
        requestBody: raw.postData || null, responseBody: null, statusCode: null, durationMs: null,
        startedAt: Date.now(), completedAt: null, traceId: null, spanId: null, parentSpanId: null,
        serviceName: null, scenarioApplied: null, error: null, isClientSide: true,
        graphqlOperation: null, graphqlOperationType: null
      };
    } catch (_) {
      return null;
    }
  }
}
