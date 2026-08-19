import { CapturedRequest, RequestType, RequestMethod, Rule } from '@apilens/shared-types';
import { RuleMatcher } from '@apilens/rule-engine';

const MAX_REQUESTS = 1000;
let sessionId = '';
let isRecording = true;
let activeRules: Rule[] = [];
const ruleMatcher = new RuleMatcher();

// Store requests by tabId
const requestsByTab: Map<number, CapturedRequest[]> = new Map();
// Active pending requests
const activeRequests: Map<string, CapturedRequest> = new Map();

function generateId() {
  return crypto.randomUUID();
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
});

chrome.storage.local.get(['isRecording', 'apilens_rules'], (res) => {
  if (res && res.isRecording !== undefined) {
    isRecording = res.isRecording;
  }
  if (res && Array.isArray(res.apilens_rules)) {
    activeRules = res.apilens_rules;
  }
});

// React to storage changes live
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes.isRecording) {
      isRecording = changes.isRecording.newValue;
    }
    if (changes.apilens_rules) {
      activeRules = changes.apilens_rules.newValue || [];
    }
  }
});

function setupNetRequestRules() {
  try {
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            { header: 'X-QA-Session-ID', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: getSessionId() }
          ]
        },
        condition: {
          urlFilter: '*',
          resourceTypes: Object.values(chrome.declarativeNetRequest.ResourceType)
        }
      }]
    });
  } catch (e) {
    console.error('DeclarativeNetRequest rule set error:', e);
  }
}

function mapResourceType(type: string): RequestType {
  switch (type) {
    case 'xmlhttprequest':
    case 'fetch':
      return 'fetch';
    case 'main_frame':
    case 'sub_frame':
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
        startedAt: Date.now(),
        isClientSide: true
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
    const req = activeRequests.get(details.requestId);
    if (req) {
      req.completedAt = Date.now();
      req.durationMs = req.completedAt - req.startedAt;
      req.statusCode = details.statusCode;
      
      // Evaluate mock/failure injection rules
      evaluateAndApplyMockRules(req);
      
      saveRequest(details.tabId, req);
      activeRequests.delete(details.requestId);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const req = activeRequests.get(details.requestId);
    if (req) {
      req.completedAt = Date.now();
      req.durationMs = req.completedAt - req.startedAt;
      req.error = details.error;
      
      // Evaluate mock/failure injection rules
      evaluateAndApplyMockRules(req);
      
      saveRequest(details.tabId, req);
      activeRequests.delete(details.requestId);
    }
  },
  { urls: ['<all_urls>'] }
);

function evaluateAndApplyMockRules(req: CapturedRequest) {
  if (!activeRules || activeRules.length === 0) return;

  const result = ruleMatcher.findMatchingRule(activeRules, req);
  if (result.matched && result.rule && result.action) {
    const rule = result.rule;
    const action = result.action;
    
    req.scenarioApplied = rule.name;
    rule.appliedCount = (rule.appliedCount || 0) + 1;
    
    if (action.type === 'status-code' || action.type === 'custom-body') {
      req.statusCode = action.statusCode || 500;
      if (action.responseBody) {
        req.responseBody = action.responseBody;
      }
    } else if (action.type === 'connection-reset' || action.type === 'timeout') {
      req.error = `net::ERR_${action.type.toUpperCase()}`;
    }
    
    if (action.delayMs) {
      req.durationMs = (req.durationMs || 0) + action.delayMs;
    }

    // Save rule application count back
    chrome.storage.local.set({ apilens_rules: activeRules });
  }
}

function saveRequest(tabId: number, req: CapturedRequest) {
  let list = requestsByTab.get(tabId) || [];
  list.push(req);
  if (list.length > MAX_REQUESTS) {
    list = list.slice(-MAX_REQUESTS);
  }
  requestsByTab.set(tabId, list);
  
  // Broadcast to Popup and DevTools
  chrome.runtime.sendMessage({ type: 'NEW_REQUEST', request: req, tabId }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  requestsByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_REQUESTS') {
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
    if (Array.isArray(message.rules)) {
      activeRules = message.rules;
      chrome.storage.local.set({ apilens_rules: activeRules });
    }
    sendResponse(true);
  }
  return true;
});
