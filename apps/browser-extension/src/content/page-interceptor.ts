import type { CapturedRequest, RequestMethod, RequestType, Rule, RuleAction, RuleEvaluationResult } from '@apilens/shared-types';

const interceptorVersion = '0.6.1';
const interceptorWindow = window as typeof window & {
  __APILENS_INTERCEPTOR_VERSION__?: string;
  __APILENS_FETCH_WRAPPER__?: typeof window.fetch;
  __APILENS_FETCH_DOWNSTREAM__?: typeof window.fetch;
  __APILENS_XHR_WRAPPER__?: typeof window.XMLHttpRequest;
  __APILENS_XHR_DOWNSTREAM__?: typeof window.XMLHttpRequest;
  __APILENS_BEACON_WRAPPER__?: typeof navigator.sendBeacon;
  __APILENS_BEACON_DOWNSTREAM__?: typeof navigator.sendBeacon;
  __APILENS_WEBSOCKET_WRAPPER__?: typeof window.WebSocket;
  __APILENS_WEBSOCKET_DOWNSTREAM__?: typeof window.WebSocket;
  __APILENS_EVENTSOURCE_WRAPPER__?: typeof window.EventSource;
  __APILENS_EVENTSOURCE_DOWNSTREAM__?: typeof window.EventSource;
  __APILENS_PAGE_CLEANUP__?: () => void;
};
const hooksHealthy = interceptorWindow.__APILENS_INTERCEPTOR_VERSION__ === interceptorVersion
  && interceptorWindow.__APILENS_FETCH_WRAPPER__ === window.fetch
  && interceptorWindow.__APILENS_XHR_WRAPPER__ === window.XMLHttpRequest
  && interceptorWindow.__APILENS_BEACON_WRAPPER__ === navigator.sendBeacon
  && interceptorWindow.__APILENS_WEBSOCKET_WRAPPER__ === window.WebSocket
  && interceptorWindow.__APILENS_EVENTSOURCE_WRAPPER__ === window.EventSource;
if (hooksHealthy) {
  window.postMessage({ source: 'apilens-page-interceptor', type: 'READY' }, '*');
} else {
interceptorWindow.__APILENS_PAGE_CLEANUP__?.();
interceptorWindow.__APILENS_INTERCEPTOR_VERSION__ = interceptorVersion;
class PageRuleMatcher {
  findMatchingRule(candidates: Rule[], request: CapturedRequest): RuleEvaluationResult {
    for (const rule of [...candidates].sort((a, b) => a.priority - b.priority)) {
      if (!rule.enabled) continue;
      if (rule.applyMode === 'once' && rule.appliedCount >= 1) continue;
      if (rule.applyMode === 'n-times' && rule.applyLimit !== undefined && rule.appliedCount >= rule.applyLimit) continue;
      if (rule.applyMode === 'probability' && Math.random() * 100 >= (rule.applyProbability ?? 100)) continue;
      const results = rule.conditions.map(condition => {
        let target: string | undefined;
        if (condition.field === 'url') target = request.url;
        else if (condition.field === 'path') target = request.path;
        else if (condition.field === 'method') target = request.method;
        else if (condition.field === 'hostname') target = request.hostname;
        else if (condition.field === 'body') target = request.requestBody || undefined;
        else if (condition.field === 'statusCode') target = request.statusCode?.toString();
        else if (condition.field === 'serviceName') target = request.serviceName || undefined;
        else if (condition.field === 'graphqlOperation') target = request.graphqlOperation || undefined;
        else if (condition.field === 'query' && condition.key) {
          const key = Object.keys(request.queryParams).find(value => value.toLowerCase() === condition.key!.toLowerCase());
          target = key ? request.queryParams[key] : undefined;
        }
        else if (condition.field === 'header' && condition.key) {
          const key = Object.keys(request.requestHeaders).find(value => value.toLowerCase() === condition.key!.toLowerCase());
          target = key ? request.requestHeaders[key] : undefined;
        }
        if (condition.operator === 'exists') return target != null;
        if (condition.operator === 'notExists') return target == null;
        if (target == null) return false;
        const actual = condition.caseSensitive || condition.operator === 'regex' ? target : target.toLowerCase();
        const expected = condition.caseSensitive || condition.operator === 'regex' ? condition.value : condition.value.toLowerCase();
        if (condition.operator === 'equals') return actual === expected;
        if (condition.operator === 'contains') return actual.includes(expected);
        if (condition.operator === 'startsWith') return actual.startsWith(expected);
        if (condition.operator === 'endsWith') return actual.endsWith(expected);
        if (condition.operator === 'regex') {
          try { return new RegExp(expected, condition.caseSensitive ? '' : 'i').test(actual); } catch (_) { return false; }
        }
        return false;
      });
      const matched = rule.conditions.length === 0 || (rule.conditionLogic === 'and' ? results.every(Boolean) : results.some(Boolean));
      if (matched) return { matched: true, rule, action: rule.action, reason: `Matched rule: ${rule.name}` };
    }
    return { matched: false, rule: null, action: null, reason: 'No rules matched' };
  }
}

class PageRuleExecutor {
  executeAction(action: RuleAction, originalBody?: string) {
    let statusCode = action.statusCode || 200;
    let body = action.responseBody || '';
    let headers = { ...(action.responseHeaders || {}) };
    let delayMs = action.delayMs || 0;
    let shouldBlock = false;
    if (action.type === 'status-code' && !body) body = JSON.stringify({ error: { code: statusCode, message: 'ApiLens mocked response' } });
    if (action.type === 'connection-reset' || action.type === 'timeout' || action.type === 'dns-failure' || action.type === 'malformed-headers' || action.type === 'websocket-disconnect' || action.type === 'sse-interrupt') shouldBlock = true;
    if (action.type === 'empty-response') body = '';
    if (action.type === 'invalid-json') { body = '{"invalid":"json","broken":'; headers['Content-Type'] = 'application/json'; }
    if (action.type === 'truncated-json') { body = '{"data":{"items":[1,2,3'; headers['Content-Type'] = 'application/json'; }
    if (action.type === 'slow-response') delayMs = action.delayMs || 5000;
    if (action.type === 'rate-limit') { statusCode = 429; body = action.responseBody || 'Rate Limit Exceeded'; headers['Retry-After'] = '60'; }
    if (['missing-field', 'null-field', 'wrong-type'].includes(action.type) && action.modifyField && originalBody) {
      try {
        const value = JSON.parse(originalBody);
        const parts = action.modifyField.path.split('.');
        let target = value;
        for (let index = 0; index < parts.length - 1; index++) target = target[parts[index]] ??= {};
        const key = parts[parts.length - 1];
        if (action.modifyField.operation === 'delete') delete target[key];
        else if (action.modifyField.operation === 'nullify') target[key] = null;
        else if (action.modifyField.operation === 'set') target[key] = action.modifyField.value;
        else target[key] = typeof target[key] === 'string' ? 123 : String(target[key]);
        body = JSON.stringify(value); headers['Content-Type'] = 'application/json';
      } catch (_) { body = originalBody; }
    }
    return { statusCode, body, headers, delayMs, shouldBlock };
  }
}

const matcher = new PageRuleMatcher();
const executor = new PageRuleExecutor();
const previousFetchWrapper = interceptorWindow.__APILENS_FETCH_WRAPPER__;
const fetchDownstream = window.fetch === previousFetchWrapper
  ? interceptorWindow.__APILENS_FETCH_DOWNSTREAM__ || window.fetch
  : window.fetch;
const nativeFetch = fetchDownstream.bind(window);
interceptorWindow.__APILENS_FETCH_DOWNSTREAM__ = fetchDownstream;

const previousXHRWrapper = interceptorWindow.__APILENS_XHR_WRAPPER__;
const NativeXHR = window.XMLHttpRequest === previousXHRWrapper
  ? interceptorWindow.__APILENS_XHR_DOWNSTREAM__ || window.XMLHttpRequest
  : window.XMLHttpRequest;
interceptorWindow.__APILENS_XHR_DOWNSTREAM__ = NativeXHR;
const previousBeaconWrapper = interceptorWindow.__APILENS_BEACON_WRAPPER__;
const beaconDownstream = navigator.sendBeacon === previousBeaconWrapper
  ? interceptorWindow.__APILENS_BEACON_DOWNSTREAM__ || navigator.sendBeacon
  : navigator.sendBeacon;
const nativeSendBeacon = beaconDownstream?.bind(navigator);
interceptorWindow.__APILENS_BEACON_DOWNSTREAM__ = beaconDownstream;

const previousWebSocketWrapper = interceptorWindow.__APILENS_WEBSOCKET_WRAPPER__;
const NativeWebSocket = window.WebSocket === previousWebSocketWrapper
  ? interceptorWindow.__APILENS_WEBSOCKET_DOWNSTREAM__ || window.WebSocket
  : window.WebSocket;
interceptorWindow.__APILENS_WEBSOCKET_DOWNSTREAM__ = NativeWebSocket;

const previousEventSourceWrapper = interceptorWindow.__APILENS_EVENTSOURCE_WRAPPER__;
const NativeEventSource = window.EventSource === previousEventSourceWrapper
  ? interceptorWindow.__APILENS_EVENTSOURCE_DOWNSTREAM__ || window.EventSource
  : window.EventSource;
interceptorWindow.__APILENS_EVENTSOURCE_DOWNSTREAM__ = NativeEventSource;
let rules: Rule[] = [];
let rulesRevision = '';
let selfTestRule: Rule | null = null;

function candidateRules() {
  return selfTestRule ? [selfTestRule, ...rules] : rules;
}

function publishStatus() {
  const fetchPatched = interceptorWindow.__APILENS_FETCH_WRAPPER__ === window.fetch;
  const xhrPatched = interceptorWindow.__APILENS_XHR_WRAPPER__ === window.XMLHttpRequest;
  const beaconPatched = interceptorWindow.__APILENS_BEACON_WRAPPER__ === navigator.sendBeacon;
  const webSocketPatched = interceptorWindow.__APILENS_WEBSOCKET_WRAPPER__ === window.WebSocket;
  const eventSourcePatched = interceptorWindow.__APILENS_EVENTSOURCE_WRAPPER__ === window.EventSource;
  window.postMessage({
    source: 'apilens-page-interceptor',
    type: 'INTERCEPTOR_STATUS',
    status: {
      version: interceptorVersion,
      installed: fetchPatched && xhrPatched,
      allTransportHooksPatched: fetchPatched && xhrPatched && beaconPatched && webSocketPatched && eventSourcePatched,
      fetchPatched,
      xhrPatched,
      beaconPatched,
      webSocketPatched,
      eventSourcePatched,
      ruleCount: rules.filter(rule => rule.enabled).length,
      rulesRevision,
      frameUrl: location.href,
      updatedAt: Date.now()
    }
  }, '*');
}

const bridgeMessageListener = (event: MessageEvent) => {
  if (event.source !== window || event.data?.source !== 'apilens-isolated-bridge') return;
  if (event.data.type === 'RULES_UPDATED') {
    rules = Array.isArray(event.data.rules) ? event.data.rules : [];
    rulesRevision = typeof event.data.revision === 'string' ? event.data.revision : '';
    publishStatus();
  }
  if (event.data.type === 'RUN_SELF_TEST' && typeof event.data.requestId === 'string') {
    void runSelfTest(event.data.requestId);
  }
};
window.addEventListener('message', bridgeMessageListener);
interceptorWindow.__APILENS_PAGE_CLEANUP__ = () => window.removeEventListener('message', bridgeMessageListener);

function headerRecord(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key.toLowerCase()] = value; });
  return result;
}

function makeRequest(urlValue: string, methodValue: string, headers = new Headers(), body: unknown = null, type: RequestType = 'fetch'): CapturedRequest {
  const url = new URL(urlValue, location.href);
  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { queryParams[key] = value; });
  return {
    id: crypto.randomUUID(), sessionId: '', source: 'browser', type,
    method: methodValue.toUpperCase() as RequestMethod, url: url.href, path: url.pathname,
    hostname: url.hostname, queryParams, requestHeaders: headerRecord(headers), responseHeaders: {},
    requestBody: typeof body === 'string' ? body : null, responseBody: null, statusCode: null,
    durationMs: null, startedAt: Date.now(), completedAt: null, traceId: null, spanId: null,
    parentSpanId: null, serviceName: null, scenarioApplied: null, error: null, isClientSide: true,
    graphqlOperation: null, graphqlOperationType: null
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const needsOriginal = (type: string) => ['missing-field', 'null-field', 'wrong-type', 'slow-response'].includes(type);
const statusTextByCode: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  408: 'Request Timeout', 409: 'Conflict', 422: 'Unprocessable Content', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout'
};

function report(request: CapturedRequest, match: RuleEvaluationResult, response?: Response, error?: string) {
  request.completedAt = Date.now();
  request.durationMs = request.completedAt - request.startedAt;
  request.statusCode = response?.status ?? null;
  request.responseHeaders = response ? headerRecord(response.headers) : {};
  request.scenarioApplied = match.rule?.name || null;
  request.error = error || null;
  window.postMessage({ source: 'apilens-page-interceptor', type: 'MOCK_INTERCEPTED', request }, '*');
}

async function applyMock(request: CapturedRequest, match: RuleEvaluationResult, original?: Response): Promise<Response> {
  const action = match.action!;
  const originalBody = original ? await original.clone().text() : undefined;
  const mock = executor.executeAction(action, originalBody);
  if (match.rule) match.rule.appliedCount = (match.rule.appliedCount || 0) + 1;
  if (mock.delayMs > 0) await wait(mock.delayMs);

  if (mock.shouldBlock) {
    const message = action.type === 'timeout' ? 'ApiLens simulated timeout' : `ApiLens simulated ${action.type}`;
    report(request, match, undefined, message);
    throw new TypeError(message);
  }
  if (action.type === 'slow-response' && original && !action.responseBody && !action.statusCode) {
    report(request, match, original);
    return original;
  }

  const headers = new Headers(original?.headers);
  Object.entries(mock.headers).forEach(([name, value]) => {
    try { headers.set(name, value); } catch (_) { /* Invalid headers cannot be represented by the Fetch API. */ }
  });
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('x-apilens-mocked', 'true');
  headers.set('x-apilens-mocked-from', 'ApiLens');
  headers.set('x-apilens-rule', match.rule?.name || 'ApiLens rule');
  headers.set('x-apilens-transport', request.type === 'xhr' ? 'page-xhr' : 'page-fetch');
  headers.set('x-apilens-original-url', request.url);
  if (original) headers.set('x-apilens-original-status', String(original.status));
  const requestedStatus = action.statusCode || (needsOriginal(action.type) && original ? original.status : mock.statusCode);
  const status = Math.max(200, Math.min(599, requestedStatus));
  const response = new Response([204, 205, 304].includes(status) ? null : mock.body, {
    status,
    statusText: statusTextByCode[status] || original?.statusText || '',
    headers
  });
  request.responseBody = mock.body;
  report(request, match, response);
  return response;
}

async function runSelfTest(requestId: string) {
  const marker = `apilens-self-test-${requestId}`;
  const testUrl = `https://${marker}.invalid/api/forced-response`;
  selfTestRule = {
    id: marker,
    scenarioId: 'apilens-self-test',
    name: '__APILENS_SELF_TEST__',
    description: 'Ephemeral in-page mock-engine diagnostic',
    enabled: true,
    priority: Number.MIN_SAFE_INTEGER,
    conditions: [{ field: 'url', operator: 'contains', value: marker }],
    conditionLogic: 'and',
    action: { type: 'status-code', statusCode: 503, responseBody: '{"mockedBy":"ApiLens","selfTest":true}' },
    applyMode: 'always',
    appliedCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  try {
    const fetchResponse = await window.fetch(`${testUrl}?transport=fetch`);
    const fetchBody = await fetchResponse.text();
    const fetchResult = {
      ok: fetchResponse.status === 503 && fetchResponse.headers.get('x-apilens-mocked') === 'true' && fetchBody.includes('"selfTest":true'),
      status: fetchResponse.status,
      mockedHeader: fetchResponse.headers.get('x-apilens-mocked')
    };

    const xhrResult = await new Promise<{ ok: boolean; status: number; mockedHeader: string | null; error?: string }>(resolve => {
      const xhr = new window.XMLHttpRequest();
      const timer = window.setTimeout(() => resolve({ ok: false, status: xhr.status, mockedHeader: null, error: 'XHR self-test timed out.' }), 2_000);
      const finish = (result: { ok: boolean; status: number; mockedHeader: string | null; error?: string }) => {
        window.clearTimeout(timer);
        resolve(result);
      };
      xhr.onload = () => {
        const mockedHeader = xhr.getResponseHeader('x-apilens-mocked');
        finish({
          ok: xhr.status === 503 && mockedHeader === 'true' && xhr.responseText.includes('"selfTest":true'),
          status: xhr.status,
          mockedHeader
        });
      };
      xhr.onerror = () => finish({ ok: false, status: xhr.status, mockedHeader: null, error: 'XHR self-test emitted an error.' });
      xhr.open('GET', `${testUrl}?transport=xhr`);
      xhr.send();
    });

    window.postMessage({
      source: 'apilens-page-interceptor',
      type: 'SELF_TEST_RESULT',
      requestId,
      result: { ok: fetchResult.ok && xhrResult.ok, fetch: fetchResult, xhr: xhrResult, testedAt: Date.now() }
    }, '*');
  } catch (error) {
    window.postMessage({
      source: 'apilens-page-interceptor',
      type: 'SELF_TEST_RESULT',
      requestId,
      result: { ok: false, error: error instanceof Error ? error.message : String(error), testedAt: Date.now() }
    }, '*');
  } finally {
    selfTestRule = null;
  }
}

const apiLensFetch: typeof window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const inputRequest = input instanceof Request ? input : null;
  const request = makeRequest(
    inputRequest?.url || String(input),
    init?.method || inputRequest?.method || 'GET',
    new Headers(init?.headers || inputRequest?.headers),
    init?.body
  );
  let match = matcher.findMatchingRule(candidateRules(), request);
  if (match.matched && !needsOriginal(match.action!.type)) return applyMock(request, match);

  const response = await nativeFetch(input, init);
  if (!match.matched) {
    request.statusCode = response.status;
    match = matcher.findMatchingRule(candidateRules(), request);
  }
  return match.matched ? applyMock(request, match, response) : response;
};
window.fetch = apiLensFetch;
interceptorWindow.__APILENS_FETCH_WRAPPER__ = apiLensFetch;

class MockableXHR extends EventTarget {
  static readonly UNSENT = 0; static readonly OPENED = 1; static readonly HEADERS_RECEIVED = 2;
  static readonly LOADING = 3; static readonly DONE = 4;
  readonly UNSENT = 0; readonly OPENED = 1; readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3; readonly DONE = 4;
  private native = new NativeXHR();
  private mocked = false;
  private method = 'GET';
  private url = '';
  private headers = new Headers();
  private resultHeaders = new Headers();
  private state = 0;
  private resultStatus = 0;
  private resultStatusText = '';
  private resultText = '';
  private result: unknown = null;
  private stopped = false;
  onreadystatechange: ((this: XMLHttpRequest, ev: Event) => unknown) | null = null;
  onload: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onerror: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  ontimeout: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onabort: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onloadstart: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onloadend: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onprogress: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;

  constructor() {
    super();
    ['readystatechange', 'load', 'error', 'timeout', 'abort', 'loadstart', 'loadend', 'progress'].forEach(type => {
      this.native.addEventListener(type, event => this.forward(type, event));
    });
  }
  get readyState() { return this.mocked ? this.state : this.native.readyState; }
  get status() { return this.mocked ? this.resultStatus : this.native.status; }
  get statusText() { return this.mocked ? this.resultStatusText : this.native.statusText; }
  get response() { return this.mocked ? this.result : this.native.response; }
  get responseText() { return this.mocked ? this.resultText : this.native.responseText; }
  get responseURL() { return this.mocked ? this.url : this.native.responseURL; }
  get responseXML() { return this.mocked ? null : this.native.responseXML; }
  get upload() { return this.native.upload; }
  get timeout() { return this.native.timeout; } set timeout(value: number) { this.native.timeout = value; }
  get withCredentials() { return this.native.withCredentials; } set withCredentials(value: boolean) { this.native.withCredentials = value; }
  get responseType() { return this.native.responseType; } set responseType(value: XMLHttpRequestResponseType) { this.native.responseType = value; }

  open(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
    this.method = method;
    this.url = new URL(String(url), location.href).href;
    this.state = 1;
    this.native.open(method, this.url, async, username, password);
  }
  setRequestHeader(name: string, value: string) { this.headers.append(name, value); this.native.setRequestHeader(name, value); }
  overrideMimeType(mime: string) { this.native.overrideMimeType(mime); }
  getResponseHeader(name: string) { return this.mocked ? this.resultHeaders.get(name) : this.native.getResponseHeader(name); }
  getAllResponseHeaders() { return this.mocked ? [...this.resultHeaders].map(([k, v]) => `${k}: ${v}`).join('\r\n') : this.native.getAllResponseHeaders(); }
  abort() {
    this.stopped = true;
    if (this.mocked) {
      this.state = 0;
      this.emit('abort');
      this.emit('loadend');
    } else {
      this.native.abort();
    }
  }

  send(body?: Document | XMLHttpRequestBodyInit | null) {
    const request = makeRequest(this.url, this.method, this.headers, body, 'xhr');
    let match = matcher.findMatchingRule(candidateRules(), request);
    const needsStatusEvaluation = candidateRules().some(rule => rule.enabled && rule.conditions.some(condition => condition.field === 'statusCode'));
    if (!match.matched && !needsStatusEvaluation) { this.native.send(body); return; }
    this.mocked = true;
    this.emit('loadstart');
    const run = async () => {
      let original: Response | undefined;
      if (!match.matched || needsOriginal(match.action!.type)) {
        const method = this.method.toUpperCase();
        original = await nativeFetch(this.url, {
          method,
          headers: this.headers,
          body: method === 'GET' || method === 'HEAD' || body instanceof Document ? undefined : body as BodyInit,
          credentials: this.withCredentials ? 'include' : 'same-origin'
        });
      }
      if (!match.matched && original) {
        request.statusCode = original.status;
        match = matcher.findMatchingRule(candidateRules(), request);
      }
      return match.matched ? applyMock(request, match, original) : original!;
    };
    run().then(async response => {
      if (this.stopped) return;
      this.resultStatus = response.status;
      this.resultStatusText = response.statusText;
      this.resultHeaders = new Headers(response.headers);
      this.state = 2; this.emit('readystatechange');
      this.state = 3; this.emit('readystatechange');
      const responseType = this.responseType;
      if (responseType === 'blob') {
        this.result = await response.blob();
      } else if (responseType === 'arraybuffer') {
        this.result = await response.arrayBuffer();
      } else {
        this.resultText = await response.text();
        if (responseType === 'json') {
          try { this.result = JSON.parse(this.resultText || 'null'); } catch (_) { this.result = null; }
        } else {
          this.result = this.resultText;
        }
      }
      this.state = 4; this.emit('readystatechange'); this.emit('load'); this.emit('loadend');
    }).catch(() => {
      if (this.stopped) return;
      this.state = 4; this.emit('readystatechange');
      this.emit(match.action?.type === 'timeout' ? 'timeout' : 'error'); this.emit('loadend');
    });
  }

  private emit(type: string) {
    const event = new ProgressEvent(type);
    this.dispatchEvent(event);
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === 'function') handler.call(this, event);
  }
  private forward(type: string, event: Event) {
    this.dispatchEvent(new Event(type));
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === 'function') handler.call(this, event);
  }
}

window.XMLHttpRequest = MockableXHR as unknown as typeof XMLHttpRequest;
interceptorWindow.__APILENS_XHR_WRAPPER__ = window.XMLHttpRequest;

if (nativeSendBeacon) {
  const apiLensSendBeacon = (url: string | URL, data?: BodyInit | null) => {
    const request = makeRequest(String(url), 'POST', new Headers(), data, 'beacon');
    const match = matcher.findMatchingRule(candidateRules(), request);
    if (!match.matched) return nativeSendBeacon(url, data);
    const mock = executor.executeAction(match.action!);
    void applyMock(request, match).catch(() => {});
    return !mock.shouldBlock && mock.statusCode < 400;
  };
  try {
    navigator.sendBeacon = apiLensSendBeacon;
    interceptorWindow.__APILENS_BEACON_WRAPPER__ = apiLensSendBeacon;
  } catch (_) {
    // Some pages freeze Navigator; fetch/XHR mocking must continue independently.
  }
}

class MockSocket extends EventTarget {
  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readonly bufferedAmount = 0;
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;
  constructor(url: string) {
    super(); this.url = url;
    queueMicrotask(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit('error', new Event('error'));
      this.emit('close', new CloseEvent('close', { code: 1011, reason: 'Mocked by ApiLens', wasClean: false }));
    });
  }
  send() { throw new DOMException('ApiLens mocked WebSocket is closed', 'InvalidStateError'); }
  close() { this.readyState = WebSocket.CLOSED; }
  private emit(name: 'error' | 'close', event: Event) {
    this.dispatchEvent(event);
    const handler = name === 'error' ? this.onerror : this.onclose;
    if (handler) handler.call(this as unknown as WebSocket, event as never);
  }
}

const apiLensWebSocket = new Proxy(NativeWebSocket, {
  construct(target, args: [string | URL, string | string[] | undefined]) {
    const url = String(args[0]);
    const request = makeRequest(url, 'GET', new Headers(), null, 'websocket');
    const match = matcher.findMatchingRule(candidateRules(), request);
    if (!match.matched) return Reflect.construct(target, args);
    if (match.rule) match.rule.appliedCount = (match.rule.appliedCount || 0) + 1;
    report(request, match, undefined, 'Mocked WebSocket disconnect by ApiLens');
    return new MockSocket(url);
  }
});
try {
  window.WebSocket = apiLensWebSocket;
  interceptorWindow.__APILENS_WEBSOCKET_WRAPPER__ = apiLensWebSocket;
} catch (_) {
  // Keep the primary fetch/XHR engine active when the page locks this constructor.
}

class MockEventStream extends EventTarget {
  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = EventSource.CONNECTING;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  constructor(url: string, withCredentials: boolean, body: string, fail: boolean) {
    super(); this.url = url; this.withCredentials = withCredentials;
    queueMicrotask(() => {
      if (fail) {
        this.readyState = EventSource.CLOSED;
        const event = new Event('error'); this.dispatchEvent(event);
        this.onerror?.call(this as unknown as EventSource, event);
        return;
      }
      this.readyState = EventSource.OPEN;
      const open = new Event('open'); this.dispatchEvent(open); this.onopen?.call(this as unknown as EventSource, open);
      const message = new MessageEvent('message', { data: body });
      this.dispatchEvent(message); this.onmessage?.call(this as unknown as EventSource, message);
    });
  }
  close() { this.readyState = EventSource.CLOSED; }
}

const apiLensEventSource = new Proxy(NativeEventSource, {
  construct(target, args: [string | URL, EventSourceInit | undefined]) {
    const url = String(args[0]);
    const request = makeRequest(url, 'GET', new Headers(), null, 'sse');
    const match = matcher.findMatchingRule(candidateRules(), request);
    if (!match.matched) return Reflect.construct(target, args);
    const mock = executor.executeAction(match.action!);
    if (match.rule) match.rule.appliedCount = (match.rule.appliedCount || 0) + 1;
    report(request, match, undefined, mock.shouldBlock ? 'Mocked SSE interruption by ApiLens' : undefined);
    return new MockEventStream(url, Boolean(args[1]?.withCredentials), mock.body, mock.shouldBlock);
  }
});
try {
  window.EventSource = apiLensEventSource;
  interceptorWindow.__APILENS_EVENTSOURCE_WRAPPER__ = apiLensEventSource;
} catch (_) {
  // Keep the primary fetch/XHR engine active when the page locks this constructor.
}
publishStatus();
window.postMessage({ source: 'apilens-page-interceptor', type: 'READY' }, '*');
}
