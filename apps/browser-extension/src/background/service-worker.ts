import { CapturedRequest, RequestType, RequestMethod, Rule } from '@apilens/shared-types';
import { extensionApi as api } from '../shared/browser-api';
import { ChromiumNetworkMock } from './chromium-network-mock';
import { isTopFrameSynchronized, revisionForRules } from '../shared/interceptor-health';

const MAX_REQUESTS = 1000;
let sessionId = '';
let isRecording = true;
let activeRules: Rule[] = [];
let activeRulesRevision = revisionForRules(activeRules);
let serverIntegrationEnabled = false;
const serverTraceIds = new Set<string>();
const interceptorStatusByTab = new Map<number, Map<number, any>>();
const interceptorErrorsByTab = new Map<number, string>();
const lastInterceptorRepairAtByTab = new Map<number, number>();
const interceptorSelfTestByTab = new Map<number, any>();
const mockedNetworkRequestIds = new Set<string>();
let traceSocket: WebSocket | null = null;
let traceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let traceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Store requests by tabId
const requestsByTab: Map<number, CapturedRequest[]> = new Map();
// Active pending requests
const activeRequests: Map<string, CapturedRequest> = new Map();
const chromiumNetworkMock = new ChromiumNetworkMock(
  () => activeRules,
  (tabId, request, rule, networkRequestId) => recordNetworkMock(tabId, request, rule, networkRequestId)
);

function generateId() {
  return crypto.randomUUID();
}

function replaceActiveRules(rules: Rule[]) {
  activeRules = rules;
  activeRulesRevision = revisionForRules(rules);
}

function getSessionId() {
  if (!sessionId) {
    sessionId = generateId();
    chrome.storage.session?.set({ sessionId });
  }
  return sessionId;
}

// Load initial state
chrome.storage.session?.get(['sessionId'], (res) => {
  if (res && res.sessionId) {
    sessionId = res.sessionId;
  } else {
    getSessionId();
  }
  setupNetRequestRules();
  if (serverIntegrationEnabled) connectTraceGateway();
});

function connectTraceGateway() {
  if (!serverIntegrationEnabled || !sessionId || traceSocket?.readyState === WebSocket.OPEN || traceSocket?.readyState === WebSocket.CONNECTING) return;

  chrome.storage.local.get(['traceGatewayUrl'], result => {
    const baseUrl = String(result.traceGatewayUrl || 'ws://localhost:3002').replace(/\/$/, '');
    traceSocket = new WebSocket(`${baseUrl}/ws/sessions/${encodeURIComponent(getSessionId())}`);

    traceSocket.onopen = () => {
      if (traceReconnectTimer) clearTimeout(traceReconnectTimer);
      traceReconnectTimer = null;
      if (traceHeartbeatTimer) clearInterval(traceHeartbeatTimer);
      traceHeartbeatTimer = setInterval(() => {
        if (traceSocket?.readyState === WebSocket.OPEN) traceSocket.send('ping');
      }, 20_000);
    };

    traceSocket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type !== 'traces_update') return;
        const spans = Array.isArray(message.data) ? message.data : [message.data];
        spans.forEach(addServerTrace);
      } catch (error) {
        console.error('ApiLens could not parse a server trace:', error);
      }
    };

    traceSocket.onclose = () => {
      traceSocket = null;
      if (traceHeartbeatTimer) clearInterval(traceHeartbeatTimer);
      traceHeartbeatTimer = null;
      if (serverIntegrationEnabled) traceReconnectTimer = setTimeout(connectTraceGateway, 3_000);
    };

    traceSocket.onerror = () => traceSocket?.close();
  });
}

function disconnectTraceGateway() {
  if (traceReconnectTimer) clearTimeout(traceReconnectTimer);
  if (traceHeartbeatTimer) clearInterval(traceHeartbeatTimer);
  traceReconnectTimer = null;
  traceHeartbeatTimer = null;
  traceSocket?.close();
  traceSocket = null;
}

function addServerTrace(span: any) {
  const id = String(span.id || span.spanId || generateId());
  if (serverTraceIds.has(id)) return;
  serverTraceIds.add(id);
  if (serverTraceIds.size > MAX_REQUESTS * 2) {
    const oldest = serverTraceIds.values().next().value;
    if (oldest) serverTraceIds.delete(oldest);
  }

  const rawUrl = String(span.url || span.attributes?.url || 'server://unknown');
  let hostname = String(span.serviceName || 'server');
  let path = rawUrl;
  try {
    const parsed = new URL(rawUrl, 'http://server.local');
    hostname = parsed.hostname === 'server.local' ? hostname : parsed.hostname;
    path = parsed.pathname + parsed.search;
  } catch (_) {
    // Keep the operation name as the visible path for non-URL spans.
  }

  const startedAt = Number(span.startedAt ?? span.startTime ?? Date.now());
  const durationMs = Number(span.durationMs ?? span.duration ?? 0);
  const source = ['frontend-server', 'bff', 'gateway', 'internal-service'].includes(span.source)
    ? span.source
    : 'frontend-server';
  const request: CapturedRequest = {
    id: `server-${id}`,
    sessionId: String(span.sessionId || getSessionId()),
    source,
    type: 'fetch',
    method: String(span.method || 'GET').toUpperCase() as RequestMethod,
    url: rawUrl,
    path: path || String(span.operationName || span.name || 'server request'),
    hostname,
    queryParams: {},
    requestHeaders: span.requestHeaders || {},
    responseHeaders: span.responseHeaders || {},
    requestBody: null,
    responseBody: null,
    statusCode: Number(span.statusCode ?? span.status ?? 0) || null,
    durationMs,
    startedAt,
    completedAt: Number(span.endedAt ?? (startedAt + durationMs)),
    traceId: span.traceId || null,
    spanId: span.spanId || id,
    parentSpanId: span.parentSpanId || span.parentId || null,
    serviceName: span.serviceName || null,
    scenarioApplied: span.scenarioApplied || null,
    error: span.error || null,
    isClientSide: false,
    graphqlOperation: null,
    graphqlOperationType: null
  };

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id;
    if (tabId) saveRequest(tabId, request);
  });
}

chrome.storage.local.get(['isRecording', 'apilens_rules', 'serverIntegrationEnabled'], (res) => {
  if (res && res.isRecording !== undefined) {
    isRecording = res.isRecording;
  }
  if (res && Array.isArray(res.apilens_rules)) {
    replaceActiveRules(res.apilens_rules);
  }
  serverIntegrationEnabled = Boolean(res?.serverIntegrationEnabled);
  if (serverIntegrationEnabled) connectTraceGateway();
  setupNetRequestRules();
  ensurePageInterceptors();
});

// React to storage changes live
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.isRecording) {
      isRecording = changes.isRecording.newValue;
    }
    if (changes.apilens_rules) {
      replaceActiveRules(changes.apilens_rules.newValue || []);
      setupNetRequestRules();
      broadcastRules();
    }
    if (changes.serverIntegrationEnabled) {
      serverIntegrationEnabled = Boolean(changes.serverIntegrationEnabled.newValue);
      setupNetRequestRules();
      if (serverIntegrationEnabled) connectTraceGateway();
      else disconnectTraceGateway();
    }
  }
});

async function broadcastRules(targetTabId?: number) {
  const tabs = await api.tabs.query({});
  await Promise.all(tabs
    .filter(tab => tab.id && (!targetTabId || tab.id === targetTabId))
    .map(tab => api.tabs.sendMessage(tab.id!, {
      type: 'RULES_UPDATED',
      rules: activeRules,
      revision: activeRulesRevision
    }).catch(() => undefined)));
}

async function ensureWorkingMockEngine(tabId: number) {
  await ensurePageInterceptors(tabId);
  await broadcastRules(tabId);
  let health = await waitForInterceptorHealth(tabId);

  // Strict CSP and page hardening can prevent MAIN-world hooks. Chromium has a
  // browser-level Fetch interceptor that can still return the configured mock.
  if (!health.installed) {
    const network = await chromiumNetworkMock.enable(tabId);
    if (!network.active && network.error) interceptorErrorsByTab.set(tabId, network.error);
    health = getInterceptorHealth(tabId);
  }
  return health;
}

async function ensurePageInterceptors(targetTabId?: number) {
  const tabs = await api.tabs.query({});
  const eligibleTabs = tabs.filter(tab =>
    tab.id && (!targetTabId || tab.id === targetTabId) && /^https?:/i.test(tab.url || '')
  );
  await Promise.all(eligibleTabs.map(async tab => {
    try {
      interceptorErrorsByTab.delete(tab.id!);
      // The top page is the critical hook target. Inject it independently so a
      // restricted/sandboxed child frame cannot make the whole repair fail.
      await api.scripting.executeScript({
        target: { tabId: tab.id! },
        world: 'MAIN',
        files: ['content/page-interceptor.js']
      });
      await api.scripting.executeScript({
        target: { tabId: tab.id! },
        world: 'ISOLATED',
        files: ['content/content-script.js']
      });
    } catch (error) {
      interceptorErrorsByTab.set(tab.id!, error instanceof Error ? error.message : String(error));
      console.warn(`ApiLens could not install the interceptor in tab ${tab.id}:`, error);
      return;
    }

    // Static manifest scripts handle frames during normal navigation. This
    // best-effort pass repairs existing child frames without affecting top-frame health.
    try {
      await api.scripting.executeScript({
        target: { tabId: tab.id!, allFrames: true },
        world: 'MAIN',
        files: ['content/page-interceptor.js']
      });
      await api.scripting.executeScript({
        target: { tabId: tab.id!, allFrames: true },
        world: 'ISOLATED',
        files: ['content/content-script.js']
      });
    } catch (error) {
      console.debug(`ApiLens skipped one or more restricted child frames in tab ${tab.id}:`, error);
    }
  }));
}

function getInterceptorHealth(tabId: number) {
  const enabledRuleCount = activeRules.filter(rule => rule.enabled).length;
  const frameMap = interceptorStatusByTab.get(tabId);
  const frames = frameMap
    ? [...frameMap.entries()]
      .map(([frameId, status]) => ({ frameId, ...status }))
      .filter(status => Date.now() - Number(status.updatedAt || 0) < 45_000)
    : [];
  const topFrame = frames.find(frame => frame.frameId === 0);
  const hooksInstalled = Boolean(topFrame?.installed && topFrame.fetchPatched && topFrame.xhrPatched);
  const pageRulesSynced = isTopFrameSynchronized(topFrame, enabledRuleCount, activeRulesRevision);
  const networkMockActive = chromiumNetworkMock.isActive(tabId);
  const rulesSynced = pageRulesSynced || networkMockActive;
  const pageInstalled = hooksInstalled && pageRulesSynced;
  return {
    installed: pageInstalled || networkMockActive,
    hooksInstalled,
    rulesSynced,
    engine: pageInstalled ? 'page' : networkMockActive ? 'chromium-network' : 'none',
    networkMockActive,
    frames,
    enabledRuleCount,
    expectedRulesRevision: activeRulesRevision,
    selfTest: interceptorSelfTestByTab.get(tabId) || null,
    error: pageInstalled || networkMockActive ? null : interceptorErrorsByTab.get(tabId) || chromiumNetworkMock.error(tabId) || null
  };
}

async function waitForInterceptorHealth(tabId: number, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let health = getInterceptorHealth(tabId);
  while (!health.installed && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    health = getInterceptorHealth(tabId);
  }
  return health;
}

async function runInterceptorSelfTest(tabId: number) {
  try {
    const result = await api.tabs.sendMessage(tabId, { type: 'RUN_INTERCEPTOR_SELF_TEST' });
    const normalized = result?.ok ? result : { ok: false, ...result, error: result?.error || 'The mock engine self-test failed.' };
    interceptorSelfTestByTab.set(tabId, normalized);
    return normalized;
  } catch (error) {
    const result = { ok: false, error: error instanceof Error ? error.message : String(error), testedAt: Date.now() };
    interceptorSelfTestByTab.set(tabId, result);
    return result;
  }
}

async function runMockEngineSelfTest(tabId: number) {
  const health = getInterceptorHealth(tabId);
  if (health.engine === 'chromium-network') {
    const result = await chromiumNetworkMock.selfTest(tabId);
    interceptorSelfTestByTab.set(tabId, result);
    return result;
  }
  return runInterceptorSelfTest(tabId);
}

chrome.alarms.create('apilens-interceptor-health', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'apilens-interceptor-health' || !activeRules.some(rule => rule.enabled)) return;
  chrome.tabs.query({ active: true }, tabs => {
    tabs.filter(tab => tab.id && /^https?:/i.test(tab.url || '')).forEach(tab => {
      void ensureWorkingMockEngine(tab.id!);
    });
  });
});

function toBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && /^https?:/i.test(tab.url || '')) {
    interceptorStatusByTab.delete(tabId);
    interceptorSelfTestByTab.delete(tabId);
    void ensureWorkingMockEngine(tabId);
  }
});

function setupNetRequestRules() {
  chrome.storage.local.get(['serverIntegrationEnabled'], settings => {
    const dnr = api.declarativeNetRequest;
    if (!dnr?.updateDynamicRules) return;
    try {
      if (!settings.serverIntegrationEnabled) {
        void dnr.updateDynamicRules({ removeRuleIds: [1] }).catch(error => {
          console.error('ApiLens could not remove server-integration headers:', error);
        });
        return;
      }
      const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
        { header: 'X-QA-Session-ID', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: getSessionId() }
      ];
      const enabledRules = activeRules.filter(rule => rule.enabled);
      if (enabledRules.length > 0) {
        requestHeaders.push({
          header: 'X-ApiLens-Rules',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: toBase64(JSON.stringify(enabledRules))
        });
      }
      void dnr.updateDynamicRules({
        removeRuleIds: [1],
        addRules: [{
          id: 1,
          priority: 1,
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            requestHeaders
          },
          condition: {
            urlFilter: '*',
            resourceTypes: Object.values(chrome.declarativeNetRequest.ResourceType)
          }
        }]
      }).catch(error => {
        console.error('ApiLens could not install server-integration headers:', error);
      });
    } catch (e) {
      console.error('DeclarativeNetRequest rule set error:', e);
    }
  });
}

function mapResourceType(type: string): RequestType {
  switch (type) {
    case 'xmlhttprequest':
    case 'xhr':
    case 'fetch':
      return 'fetch';
    case 'main_frame':
    case 'sub_frame':
    case 'document':
      return 'navigation';
    case 'stylesheet':
    case 'script':
    case 'image':
    case 'font':
    case 'media':
      return 'static';
    case 'websocket':
      return 'websocket';
    default:
      return 'other';
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isRecording) return;
    if (details.tabId < 0) return;
    
    try {
      const url = new URL(details.url);
      const queryParams: Record<string, string> = {};
      url.searchParams.forEach((val, key) => queryParams[key] = val);

      const req: CapturedRequest = {
        id: details.requestId,
        sessionId: getSessionId(),
        source: 'browser',
        type: mapResourceType(details.type),
        method: details.method as RequestMethod,
        url: details.url,
        path: url.pathname,
        hostname: url.hostname,
        queryParams,
        requestHeaders: {},
        responseHeaders: {},
        requestBody: null,
        responseBody: null,
        statusCode: null,
        durationMs: null,
        startedAt: Date.now(),
        completedAt: null,
        traceId: null,
        spanId: null,
        parentSpanId: null,
        serviceName: null,
        scenarioApplied: null,
        error: null,
        isClientSide: true,
        graphqlOperation: null,
        graphqlOperationType: null
      };

      activeRequests.set(details.requestId, req);
    } catch (e) {
      console.error('Error parsing request:', e);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const req = activeRequests.get(details.requestId);
    if (req && details.requestHeaders) {
      details.requestHeaders.forEach(h => {
        if (h.name && h.value) req.requestHeaders[h.name.toLowerCase()] = h.value;
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const req = activeRequests.get(details.requestId);
    if (req && details.responseHeaders) {
      details.responseHeaders.forEach(h => {
        if (h.name && h.value) req.responseHeaders[h.name.toLowerCase()] = h.value;
      });
      req.statusCode = details.statusCode;
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (mockedNetworkRequestIds.delete(details.requestId)) {
      activeRequests.delete(details.requestId);
      return;
    }
    const req = activeRequests.get(details.requestId);
    if (req) {
      req.completedAt = Date.now();
      req.durationMs = req.completedAt - req.startedAt;
      req.statusCode = details.statusCode;
      
      saveRequest(details.tabId, req);
      activeRequests.delete(details.requestId);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (mockedNetworkRequestIds.delete(details.requestId)) {
      activeRequests.delete(details.requestId);
      return;
    }
    const req = activeRequests.get(details.requestId);
    if (req) {
      req.completedAt = Date.now();
      req.durationMs = req.completedAt - req.startedAt;
      req.error = details.error;
      
      saveRequest(details.tabId, req);
      activeRequests.delete(details.requestId);
    }
  },
  { urls: ['<all_urls>'] }
);

function saveRequest(tabId: number, req: CapturedRequest) {
  let list = requestsByTab.get(tabId) || [];
  list.push(req);
  if (list.length > MAX_REQUESTS) {
    list = list.slice(-MAX_REQUESTS);
  }
  requestsByTab.set(tabId, list);
  
  // Broadcast to Popup and DevTools
  api.runtime.sendMessage({ type: 'NEW_REQUEST', request: req, tabId }).catch(() => {});
}

function recordNetworkMock(tabId: number, request: CapturedRequest, rule: Rule, networkRequestId?: string) {
  request.sessionId = getSessionId();
  if (networkRequestId) {
    mockedNetworkRequestIds.add(networkRequestId);
    // Fetch.requestPaused normally exposes the same network ID as webRequest.
    // Remove the marker if an aborted request never produces a terminal event.
    setTimeout(() => mockedNetworkRequestIds.delete(networkRequestId), 30_000);
  }
  saveRequest(tabId, request);
  const storedRule = activeRules.find(item => item.id === rule.id);
  if (storedRule) {
    storedRule.appliedCount = (storedRule.appliedCount || 0) + 1;
    void api.storage.local.set({ apilens_rules: activeRules });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  requestsByTab.delete(tabId);
  interceptorStatusByTab.delete(tabId);
  interceptorErrorsByTab.delete(tabId);
  lastInterceptorRepairAtByTab.delete(tabId);
  interceptorSelfTestByTab.delete(tabId);
  void chromiumNetworkMock.disable(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INTERCEPTOR_STATUS') {
    const tabId = sender.tab?.id;
    if (tabId) {
      const frames = interceptorStatusByTab.get(tabId) || new Map<number, any>();
      frames.set(sender.frameId ?? 0, { ...message.status, updatedAt: Date.now() });
      interceptorStatusByTab.set(tabId, frames);
    }
    sendResponse(true);
  } else if (message.type === 'GET_INTERCEPTOR_STATUS') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({
        installed: false,
        hooksInstalled: false,
        rulesSynced: false,
        frames: [],
        enabledRuleCount: activeRules.filter(rule => rule.enabled).length,
        error: 'No active browser tab was found.'
      });
    } else {
      void (async () => {
        await api.tabs.sendMessage(tabId, {
          type: 'CHECK_INTERCEPTOR',
          rules: activeRules,
          revision: activeRulesRevision
        }).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 75));
        let health = getInterceptorHealth(tabId);
        const lastRepairAt = lastInterceptorRepairAtByTab.get(tabId) || 0;
        if (!health.installed && Date.now() - lastRepairAt > 10_000) {
          lastInterceptorRepairAtByTab.set(tabId, Date.now());
          interceptorStatusByTab.delete(tabId);
          interceptorErrorsByTab.delete(tabId);
          health = await ensureWorkingMockEngine(tabId);
        }
        sendResponse(health);
      })();
    }
  } else if (message.type === 'REPAIR_INTERCEPTOR') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No active browser tab was found.' });
    } else {
      interceptorStatusByTab.delete(tabId);
      interceptorErrorsByTab.delete(tabId);
      lastInterceptorRepairAtByTab.set(tabId, Date.now());
      void (async () => {
        try {
          const health = await ensureWorkingMockEngine(tabId);
          const selfTest = health.installed ? await runMockEngineSelfTest(tabId) : { ok: false, error: 'Neither the page nor network mock engine is active.' };
          sendResponse({ ...health, installed: health.installed && selfTest.ok, ok: health.installed && selfTest.ok, selfTest, error: health.error || selfTest.error || null });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    }
  } else if (message.type === 'GET_RULES') {
    sendResponse({ rules: activeRules, revision: activeRulesRevision });
  } else if (message.type === 'MOCK_INTERCEPTED') {
    const tabId = sender.tab?.id;
    if (tabId && message.request) {
      const request = message.request as CapturedRequest;
      if (request.scenarioApplied === '__APILENS_SELF_TEST__') {
        sendResponse(true);
        return true;
      }
      request.sessionId = getSessionId();
      request.id = request.id || generateId();
      saveRequest(tabId, request);
      const rule = activeRules.find(item => item.name === request.scenarioApplied);
      if (rule) {
        rule.appliedCount = (rule.appliedCount || 0) + 1;
        chrome.storage.local.set({ apilens_rules: activeRules });
      }
    }
    sendResponse(true);
  } else if (message.type === 'RUN_MOCK_SELF_TEST') {
    void (async () => {
      let tabId = message.tabId ?? sender.tab?.id;
      if (!tabId) {
        const tabs = await api.tabs.query({ active: true, currentWindow: true });
        tabId = tabs[0]?.id;
      }
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active browser tab was found.' });
        return;
      }
      let health = getInterceptorHealth(tabId);
      if (!health.installed) health = await ensureWorkingMockEngine(tabId);
      sendResponse(health.installed
        ? await runMockEngineSelfTest(tabId)
        : { ok: false, error: health.error || 'Neither the page nor network mock engine is active.' });
    })();
  } else if (message.type === 'GET_REQUESTS') {
    const targetTabId = message.tabId || sender.tab?.id;
    if (targetTabId && requestsByTab.has(targetTabId)) {
      sendResponse(requestsByTab.get(targetTabId) || []);
    } else if (!targetTabId) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeId = tabs[0]?.id;
        if (activeId && requestsByTab.has(activeId)) {
          sendResponse(requestsByTab.get(activeId) || []);
        } else {
          const all: CapturedRequest[] = [];
          requestsByTab.forEach((reqs) => all.push(...reqs));
          sendResponse(all.slice(-1000));
        }
      });
      return true;
    } else {
      sendResponse([]);
    }
  } else if (message.type === 'CLEAR_REQUESTS') {
    const targetTabId = message.tabId || sender.tab?.id;
    if (targetTabId) {
      requestsByTab.set(targetTabId, []);
    } else {
      requestsByTab.clear();
    }
    sendResponse(true);
  } else if (message.type === 'SET_RECORDING') {
    isRecording = !!message.enabled;
    chrome.storage.local.set({ isRecording });
    sendResponse(true);
  } else if (message.type === 'SYNC_RULES') {
    if (!Array.isArray(message.rules)) {
      sendResponse({ ok: false, error: 'The rule payload is invalid.' });
    } else {
      void (async () => {
        try {
          replaceActiveRules(message.rules);
          await api.storage.local.set({ apilens_rules: activeRules });
          setupNetRequestRules();

          let tabId = message.tabId ?? sender.tab?.id;
          if (!tabId) {
            const tabs = await api.tabs.query({ active: true, currentWindow: true });
            tabId = tabs[0]?.id;
          }
          if (!tabId) {
            sendResponse({ ok: false, error: 'Rules were saved, but no active browser tab was found.' });
            return;
          }

          interceptorStatusByTab.delete(tabId);
          interceptorErrorsByTab.delete(tabId);
          lastInterceptorRepairAtByTab.set(tabId, Date.now());
          const health = await ensureWorkingMockEngine(tabId);
          const selfTest = health.installed ? await runMockEngineSelfTest(tabId) : { ok: false, error: 'Neither the page nor network mock engine is active.' };
          const engineReady = health.installed && selfTest.ok;
          sendResponse({
            tabId,
            ...health,
            installed: engineReady,
            ok: engineReady,
            selfTest,
            error: health.error || selfTest.error || (engineReady ? null : 'The page did not pass the mock-engine self-test. Use Repair now, then reload the page.')
          });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    }
  }
  return true;
});
