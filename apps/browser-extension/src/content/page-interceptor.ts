import type { CapturedRequest, RequestMethod, RequestType, Rule } from '@apilens/shared-types';
import {
  captureBody,
  completeRequest,
  contentTypeOf,
  createCapturedRequest,
  createId,
  createSpanId,
  createTraceId,
  isStaticAssetPath,
  normalizeHeaders,
  parseUrl,
} from '@apilens/core';
import { executeAction, findMatchingRule, mockMarkerHeaders } from '@apilens/mock-engine';
import { extractTraceContext, formatTraceparent } from '@apilens/trace-engine';
import type { BridgeToPageMessage, PageHookStatus, PageToBridgeMessage } from '../shared/messages';

declare const __APILENS_VERSION__: string | undefined;
const VERSION = typeof __APILENS_VERSION__ === 'string' ? __APILENS_VERSION__ : '0.0.0';

interface HookWindow extends Window {
  __APILENS_VERSION__?: string;
  __APILENS_FETCH_WRAPPER__?: typeof fetch;
  __APILENS_FETCH_NATIVE__?: typeof fetch;
  __APILENS_XHR_WRAPPER__?: typeof XMLHttpRequest;
  __APILENS_XHR_NATIVE__?: typeof XMLHttpRequest;
  __APILENS_BEACON_WRAPPER__?: typeof navigator.sendBeacon;
  __APILENS_BEACON_NATIVE__?: typeof navigator.sendBeacon;
  __APILENS_WS_WRAPPER__?: typeof WebSocket;
  __APILENS_WS_NATIVE__?: typeof WebSocket;
  __APILENS_ES_WRAPPER__?: typeof EventSource;
  __APILENS_ES_NATIVE__?: typeof EventSource;
  __APILENS_CLEANUP__?: () => void;
}

const hookWindow = window as HookWindow;

/**
 * Detects whether our hooks are still the live implementations.
 *
 * Single-page apps, polyfills and other extensions frequently re-assign
 * `window.fetch`. Re-installing on top of whatever is currently installed —
 * rather than on top of a stale reference — is what keeps the mock engine
 * working across a long QA session.
 */
function hooksAreHealthy(): boolean {
  return (
    hookWindow.__APILENS_VERSION__ === VERSION &&
    hookWindow.__APILENS_FETCH_WRAPPER__ === window.fetch &&
    hookWindow.__APILENS_XHR_WRAPPER__ === window.XMLHttpRequest &&
    hookWindow.__APILENS_BEACON_WRAPPER__ === navigator.sendBeacon &&
    hookWindow.__APILENS_WS_WRAPPER__ === window.WebSocket &&
    hookWindow.__APILENS_ES_WRAPPER__ === window.EventSource
  );
}

if (hooksAreHealthy()) {
  post({ source: 'apilens-page', type: 'ready' });
} else {
  install();
}

function post(message: PageToBridgeMessage): void {
  try {
    window.postMessage(message, '*');
  } catch {
    // Structured-clone failures must never break the page.
  }
}

function install(): void {
  hookWindow.__APILENS_CLEANUP__?.();
  hookWindow.__APILENS_VERSION__ = VERSION;

  let rules: Rule[] = [];
  let ruleRevision = '';
  let captureBodies = true;
  let maxBodyBytes = 256 * 1024;
  let mockingAllowed = true;
  let statusTimer: number | null = null;

  const nativeFetch = resolveNative('__APILENS_FETCH_WRAPPER__', '__APILENS_FETCH_NATIVE__', window.fetch).bind(window);
  const NativeXHR = resolveNative('__APILENS_XHR_WRAPPER__', '__APILENS_XHR_NATIVE__', window.XMLHttpRequest);
  const nativeBeacon = resolveNative('__APILENS_BEACON_WRAPPER__', '__APILENS_BEACON_NATIVE__', navigator.sendBeacon)?.bind(navigator);
  const NativeWebSocket = resolveNative('__APILENS_WS_WRAPPER__', '__APILENS_WS_NATIVE__', window.WebSocket);
  const NativeEventSource = resolveNative('__APILENS_ES_WRAPPER__', '__APILENS_ES_NATIVE__', window.EventSource);

  function resolveNative<T>(wrapperKey: keyof HookWindow, nativeKey: keyof HookWindow, current: T): T {
    const previousWrapper = hookWindow[wrapperKey] as unknown as T | undefined;
    const downstream = current === previousWrapper ? ((hookWindow[nativeKey] as unknown as T | undefined) ?? current) : current;
    (hookWindow as unknown as Record<string, unknown>)[nativeKey as string] = downstream;
    return downstream;
  }

  const sessionOrigin = createId();

  function makeRequest(url: string, method: string, type: RequestType, headers: Record<string, string>, body: string | null): CapturedRequest {
    const parsed = parseUrl(url, location.href);
    const base = createCapturedRequest({
      sessionId: '',
      url: parsed.valid ? parsed.href : url,
      method: method.toUpperCase() as RequestMethod,
      channel: 'page-hook',
      source: 'browser',
      type: parsed.valid && isStaticAssetPath(parsed.path) ? 'static' : type,
      originId: sessionOrigin,
    });

    const context = extractTraceContext(headers);
    return {
      ...base,
      requestHeaders: headers,
      requestBody: captureBodies && body !== null ? captureBody(body, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(headers) }) : null,
      pageUrl: location.href,
      initiator: location.origin,
      traceId: context?.traceId ?? null,
      spanId: context?.spanId ?? null,
      correlationId: context?.correlationId ?? null,
      graphql: detectGraphql(parsed.path, body),
    };
  }

  function detectGraphql(path: string, body: string | null): CapturedRequest['graphql'] {
    if (!body || !/graphql/i.test(path)) return null;
    try {
      const parsed = JSON.parse(body) as { operationName?: string; query?: string };
      if (typeof parsed.query !== 'string') return null;
      const match = /^\s*(query|mutation|subscription)\b/.exec(parsed.query);
      return {
        operationName: parsed.operationName ?? null,
        operationType: (match?.[1] as 'query' | 'mutation' | 'subscription' | undefined) ?? 'query',
      };
    } catch {
      return null;
    }
  }

  function emit(request: CapturedRequest): void {
    post({ source: 'apilens-page', type: 'request', request });
  }

  function matchRule(request: CapturedRequest) {
    if (!mockingAllowed || rules.length === 0) return null;
    const evaluation = findMatchingRule(rules, request);
    return evaluation.matched && evaluation.rule ? evaluation.rule : null;
  }

  function withTracePropagation(headers: Record<string, string>, request: CapturedRequest): Record<string, string> {
    if (headers.traceparent) return headers;
    const traceId = request.traceId ?? createTraceId();
    const spanId = request.spanId ?? createSpanId();
    return { ...headers, traceparent: formatTraceparent(traceId, spanId, true) };
  }

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /* ---------------------------- fetch ---------------------------- */

  const fetchWrapper: typeof fetch = async function apilensFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = normalizeHeaders(
      init?.headers instanceof Headers
        ? init.headers
        : (init?.headers as Record<string, string> | undefined) ??
            (input instanceof Request ? input.headers : undefined),
    );

    let requestBody: string | null = null;
    if (captureBodies && typeof init?.body === 'string') requestBody = init.body;

    let record = makeRequest(url, method, 'fetch', headers, requestBody);
    const rule = matchRule(record);

    if (rule) {
      const outcome = executeAction(rule.action, { ruleName: rule.name });
      if (!outcome.requiresOriginalResponse) {
        if (outcome.delayMs > 0) await delay(outcome.delayMs);
        record = {
          ...record,
          mock: { ruleId: rule.id, ruleName: rule.name, scenarioId: rule.scenarioId, transport: 'page-hook', failureType: rule.action.type, appliedAt: Date.now() },
          channel: 'browser-mock',
          timing: { ...record.timing, injectedDelayMs: outcome.delayMs || null },
        };

        if (outcome.abort) {
          emit(completeRequest({ ...record, error: `Aborted by ApiLens rule "${rule.name}" (${outcome.errorReason ?? 'Failed'}).` }, { statusCode: null }));
          throw new TypeError('Failed to fetch');
        }

        const responseHeaders = { ...outcome.headers, ...mockMarkerHeaders(rule.name, 'page-hook', rule.action.type) };
        emit(
          completeRequest(
            {
              ...record,
              responseHeaders,
              responseBody: captureBody(outcome.body, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(responseHeaders) }),
            },
            { statusCode: outcome.statusCode, statusText: outcome.statusText },
          ),
        );
        return new Response(outcome.statusCode === 204 || outcome.statusCode === 304 ? null : outcome.body, {
          status: outcome.statusCode,
          statusText: outcome.statusText,
          headers: responseHeaders,
        });
      }
    }

    const outgoingHeaders = rules.length > 0 || !mockingAllowed ? headers : withTracePropagation(headers, record);

    try {
      const response = await nativeFetch(input as RequestInfo, init);
      const responseHeaders = normalizeHeaders(response.headers);
      const cloned = response.clone();
      let bodyText: string | null = null;
      if (captureBodies) {
        try {
          bodyText = await cloned.text();
        } catch {
          bodyText = null;
        }
      }

      if (rule) {
        const outcome = executeAction(rule.action, { ruleName: rule.name, originalBody: bodyText, originalStatus: response.status, originalHeaders: responseHeaders });
        if (outcome.delayMs > 0) await delay(outcome.delayMs);
        const finalBody = rule.action.type === 'slow-response' ? (bodyText ?? '') : outcome.body;
        const finalStatus = rule.action.type === 'slow-response' ? response.status : outcome.statusCode;
        const mockedHeaders = { ...responseHeaders, ...outcome.headers, ...mockMarkerHeaders(rule.name, 'page-hook', rule.action.type) };

        emit(
          completeRequest(
            {
              ...record,
              requestHeaders: outgoingHeaders,
              channel: 'browser-mock',
              responseHeaders: mockedHeaders,
              responseBody: captureBody(finalBody, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(mockedHeaders) }),
              mock: { ruleId: rule.id, ruleName: rule.name, scenarioId: rule.scenarioId, transport: 'page-hook', failureType: rule.action.type, appliedAt: Date.now() },
              timing: { ...record.timing, injectedDelayMs: outcome.delayMs || null },
            },
            { statusCode: finalStatus, statusText: outcome.statusText },
          ),
        );
        return new Response(finalBody, { status: finalStatus, statusText: outcome.statusText, headers: mockedHeaders });
      }

      emit(
        completeRequest(
          {
            ...record,
            requestHeaders: outgoingHeaders,
            responseHeaders,
            responseBody: bodyText === null ? null : captureBody(bodyText, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(responseHeaders) }),
          },
          { statusCode: response.status, statusText: response.statusText },
        ),
      );
      return response;
    } catch (error) {
      emit(completeRequest({ ...record, error: error instanceof Error ? error.message : String(error) }, { statusCode: null }));
      throw error;
    }
  };

  /* ----------------------------- XHR ----------------------------- */

  class ApiLensXHR extends NativeXHR {
    private apilensMethod = 'GET';
    private apilensUrl = '';
    private apilensHeaders: Record<string, string> = {};
    private apilensBody: string | null = null;
    private apilensStartedAt = 0;

    override open(method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null): void {
      this.apilensMethod = method.toUpperCase();
      this.apilensUrl = url.toString();
      this.apilensHeaders = {};
      super.open(method, url, async ?? true, username, password);
    }

    override setRequestHeader(name: string, value: string): void {
      this.apilensHeaders[name.toLowerCase()] = value;
      super.setRequestHeader(name, value);
    }

    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
      this.apilensStartedAt = Date.now();
      this.apilensBody = typeof body === 'string' ? body : null;

      const record = makeRequest(this.apilensUrl, this.apilensMethod, 'xhr', this.apilensHeaders, this.apilensBody);
      const rule = matchRule(record);

      if (rule) {
        const outcome = executeAction(rule.action, { ruleName: rule.name });
        if (!outcome.requiresOriginalResponse) {
          void this.respondWithMock(record, rule, outcome);
          return;
        }
      }

      this.addEventListener('loadend', () => {
        const responseHeaders = parseXhrHeaders(this.getAllResponseHeaders());
        const text = this.responseType === '' || this.responseType === 'text' ? (this.responseText ?? '') : null;
        emit(
          completeRequest(
            {
              ...record,
              responseHeaders,
              responseBody: captureBodies && text !== null ? captureBody(text, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(responseHeaders) }) : null,
              timing: { ...record.timing, startedAt: this.apilensStartedAt },
            },
            {
              statusCode: this.status === 0 ? null : this.status,
              statusText: this.statusText || null,
              error: this.status === 0 ? 'Network error or request aborted.' : null,
            },
          ),
        );
      });

      super.send(body);
    }

    private async respondWithMock(record: CapturedRequest, rule: Rule, outcome: ReturnType<typeof executeAction>): Promise<void> {
      if (outcome.delayMs > 0) await delay(outcome.delayMs);

      const mocked: CapturedRequest = {
        ...record,
        channel: 'browser-mock',
        mock: { ruleId: rule.id, ruleName: rule.name, scenarioId: rule.scenarioId, transport: 'page-hook', failureType: rule.action.type, appliedAt: Date.now() },
        timing: { ...record.timing, injectedDelayMs: outcome.delayMs || null },
      };

      if (outcome.abort) {
        defineXhrState(this, { status: 0, statusText: '', responseText: '', headers: {} });
        emit(completeRequest({ ...mocked, error: `Aborted by ApiLens rule "${rule.name}".` }, { statusCode: null }));
        this.dispatchEvent(new ProgressEvent('error'));
        this.dispatchEvent(new ProgressEvent('loadend'));
        return;
      }

      const headers = { ...outcome.headers, ...mockMarkerHeaders(rule.name, 'page-hook', rule.action.type) };
      defineXhrState(this, { status: outcome.statusCode, statusText: outcome.statusText, responseText: outcome.body, headers });
      emit(
        completeRequest(
          {
            ...mocked,
            responseHeaders: headers,
            responseBody: captureBody(outcome.body, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(headers) }),
          },
          { statusCode: outcome.statusCode, statusText: outcome.statusText },
        ),
      );
      this.dispatchEvent(new Event('readystatechange'));
      this.dispatchEvent(new ProgressEvent('load'));
      this.dispatchEvent(new ProgressEvent('loadend'));
    }
  }

  function defineXhrState(
    xhr: XMLHttpRequest,
    state: { status: number; statusText: string; responseText: string; headers: Record<string, string> },
  ): void {
    const descriptors: PropertyDescriptorMap = {
      readyState: { value: 4, configurable: true },
      status: { value: state.status, configurable: true },
      statusText: { value: state.statusText, configurable: true },
      responseText: { value: state.responseText, configurable: true },
      response: { value: state.responseText, configurable: true },
      getAllResponseHeaders: {
        value: () =>
          Object.entries(state.headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join('\r\n'),
        configurable: true,
      },
      getResponseHeader: { value: (name: string) => state.headers[name.toLowerCase()] ?? null, configurable: true },
    };
    Object.defineProperties(xhr, descriptors);
  }

  function parseXhrHeaders(raw: string): Record<string, string> {
    const headers: Record<string, string> = {};
    raw
      .trim()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .forEach((line) => {
        const separator = line.indexOf(':');
        if (separator === -1) return;
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      });
    return headers;
  }

  /* --------------------------- sendBeacon --------------------------- */

  const beaconWrapper: typeof navigator.sendBeacon = function apilensSendBeacon(url, data) {
    const record = makeRequest(url.toString(), 'POST', 'beacon', {}, typeof data === 'string' ? data : null);
    const rule = matchRule(record);
    if (rule && executeAction(rule.action, { ruleName: rule.name }).abort) {
      emit(completeRequest({ ...record, channel: 'browser-mock', error: `Blocked by ApiLens rule "${rule.name}".` }, { statusCode: null }));
      return false;
    }
    const result = nativeBeacon ? nativeBeacon(url, data) : false;
    emit(completeRequest(record, { statusCode: result ? 202 : 0, error: result ? null : 'Beacon was rejected by the browser.' }));
    return result;
  };

  /* --------------------------- WebSocket --------------------------- */

  class ApiLensWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const record = makeRequest(url.toString(), 'GET', 'websocket', {}, null);
      const rule = matchRule(record);

      if (rule && (rule.action.type === 'websocket-disconnect' || executeAction(rule.action, { ruleName: rule.name }).abort)) {
        emit(completeRequest({ ...record, channel: 'browser-mock', error: `WebSocket closed by ApiLens rule "${rule.name}".` }, { statusCode: null }));
        setTimeout(() => this.close(1006, 'ApiLens simulated disconnect'), 0);
        return;
      }

      this.addEventListener('open', () => emit(completeRequest(record, { statusCode: 101, statusText: 'Switching Protocols' })));
      this.addEventListener('error', () => emit(completeRequest(record, { statusCode: null, error: 'WebSocket error.' })));
    }
  }

  /* --------------------------- EventSource --------------------------- */

  class ApiLensEventSource extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      const record = makeRequest(url.toString(), 'GET', 'sse', {}, null);
      const rule = matchRule(record);

      if (rule && (rule.action.type === 'sse-interrupt' || executeAction(rule.action, { ruleName: rule.name }).abort)) {
        emit(completeRequest({ ...record, channel: 'browser-mock', error: `Stream interrupted by ApiLens rule "${rule.name}".` }, { statusCode: null }));
        setTimeout(() => this.close(), 0);
        return;
      }

      this.addEventListener('open', () => emit(completeRequest(record, { statusCode: 200, statusText: 'OK' })));
      this.addEventListener('error', () => emit(completeRequest(record, { statusCode: null, error: 'EventSource error.' })));
    }
  }

  /* ---------------------------- install ---------------------------- */

  window.fetch = fetchWrapper;
  window.XMLHttpRequest = ApiLensXHR as unknown as typeof XMLHttpRequest;
  navigator.sendBeacon = beaconWrapper;
  window.WebSocket = ApiLensWebSocket as unknown as typeof WebSocket;
  window.EventSource = ApiLensEventSource as unknown as typeof EventSource;

  hookWindow.__APILENS_FETCH_WRAPPER__ = fetchWrapper;
  hookWindow.__APILENS_XHR_WRAPPER__ = window.XMLHttpRequest;
  hookWindow.__APILENS_BEACON_WRAPPER__ = navigator.sendBeacon;
  hookWindow.__APILENS_WS_WRAPPER__ = window.WebSocket;
  hookWindow.__APILENS_ES_WRAPPER__ = window.EventSource;

  function currentStatus(): PageHookStatus {
    return {
      installed: hooksAreHealthy(),
      fetchPatched: window.fetch === hookWindow.__APILENS_FETCH_WRAPPER__,
      xhrPatched: window.XMLHttpRequest === hookWindow.__APILENS_XHR_WRAPPER__,
      beaconPatched: navigator.sendBeacon === hookWindow.__APILENS_BEACON_WRAPPER__,
      websocketPatched: window.WebSocket === hookWindow.__APILENS_WS_WRAPPER__,
      eventSourcePatched: window.EventSource === hookWindow.__APILENS_ES_WRAPPER__,
      ruleCount: rules.filter((rule) => rule.enabled).length,
      ruleRevision,
      version: VERSION,
      updatedAt: Date.now(),
    };
  }

  function reportStatus(): void {
    post({ source: 'apilens-page', type: 'status', status: currentStatus() });
  }

  /**
   * Proves end-to-end that a mock can actually be served in this page, rather
   * than merely that the hooks are assigned. Uses a sentinel URL that never
   * leaves the page.
   */
  async function runSelfTest(requestId: string): Promise<void> {
    const sentinel = 'https://apilens.invalid/__self_test__';
    const probe: Rule = {
      id: '__apilens_self_test__',
      scenarioId: null,
      name: '__APILENS_SELF_TEST__',
      description: '',
      enabled: true,
      priority: -1,
      conditions: [{ field: 'url', operator: 'equals', value: sentinel }],
      conditionLogic: 'and',
      action: { type: 'status-code', statusCode: 418, responseBody: '{"apilens":"ok"}' },
      applyMode: 'always',
      appliedCount: 0,
      environments: [],
      createdAt: 0,
      updatedAt: 0,
    };

    const previousRules = rules;
    const previousMocking = mockingAllowed;
    rules = [probe, ...previousRules];
    mockingAllowed = true;

    try {
      const response = await window.fetch(sentinel);
      const ok = response.status === 418 && response.headers.get('x-apilens-mocked') === 'true';
      post({
        source: 'apilens-page',
        type: 'self-test-result',
        requestId,
        result: { ok, error: ok ? undefined : `Self-test returned ${response.status} instead of a mocked 418.`, testedAt: Date.now() },
      });
    } catch (error) {
      post({
        source: 'apilens-page',
        type: 'self-test-result',
        requestId,
        result: { ok: false, error: error instanceof Error ? error.message : String(error), testedAt: Date.now() },
      });
    } finally {
      rules = previousRules;
      mockingAllowed = previousMocking;
    }
  }

  const bridgeListener = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const data = event.data as BridgeToPageMessage | undefined;
    if (!data || data.source !== 'apilens-bridge') return;

    if (data.type === 'rules') {
      rules = data.rules ?? [];
      ruleRevision = data.revision ?? '';
      if (typeof data.mockingAllowed === 'boolean') mockingAllowed = data.mockingAllowed;
      reportStatus();
      return;
    }
    if (data.type === 'settings') {
      if (typeof data.captureBodies === 'boolean') captureBodies = data.captureBodies;
      if (typeof data.maxBodyBytes === 'number') maxBodyBytes = data.maxBodyBytes;
      if (typeof data.mockingAllowed === 'boolean') mockingAllowed = data.mockingAllowed;
      return;
    }
    if (data.type === 'self-test' && data.requestId) {
      void runSelfTest(data.requestId);
    }
  };

  window.addEventListener('message', bridgeListener);

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    post({
      source: 'apilens-page',
      type: 'console',
      level: 'error',
      text: args.map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg))).join(' '),
      timestamp: Date.now(),
    });
    originalConsoleError(...args);
  };

  function safeStringify(value: unknown): string {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  statusTimer = window.setInterval(reportStatus, 15_000);

  hookWindow.__APILENS_CLEANUP__ = (): void => {
    window.removeEventListener('message', bridgeListener);
    if (statusTimer !== null) window.clearInterval(statusTimer);
    console.error = originalConsoleError;
  };

  post({ source: 'apilens-page', type: 'ready' });
  reportStatus();
}
