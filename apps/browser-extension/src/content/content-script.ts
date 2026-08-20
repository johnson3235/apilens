import type { Rule } from '@apilens/shared-types';

const runtimeApi: typeof chrome = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? chrome;
const bridgeWindow = globalThis as typeof globalThis & { __APILENS_BRIDGE_CLEANUP__?: () => void };
bridgeWindow.__APILENS_BRIDGE_CLEANUP__?.();

let rules: Rule[] = [];
let rulesRevision = '';
const pendingSelfTests = new Map<string, { respond: (result: unknown) => void; timer: number }>();

function publishRules() {
  window.postMessage({
    source: 'apilens-isolated-bridge',
    type: 'RULES_UPDATED',
    rules,
    revision: rulesRevision
  }, '*');
}

const runtimeListener = (message: any, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  if (message.type === 'RULES_UPDATED' && Array.isArray(message.rules)) {
    rules = message.rules;
    rulesRevision = typeof message.revision === 'string' ? message.revision : '';
    publishRules();
  }
  if (message.type === 'CHECK_INTERCEPTOR') {
    if (Array.isArray(message.rules)) rules = message.rules;
    rulesRevision = typeof message.revision === 'string' ? message.revision : rulesRevision;
    publishRules();
  }
  if (message.type === 'RUN_INTERCEPTOR_SELF_TEST') {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      pendingSelfTests.delete(requestId);
      sendResponse({ ok: false, error: 'The page interceptor did not answer the self-test.' });
    }, 3_000);
    pendingSelfTests.set(requestId, { respond: sendResponse, timer });
    window.postMessage({ source: 'apilens-isolated-bridge', type: 'RUN_SELF_TEST', requestId }, '*');
    return true;
  }
};

const pageListener = (event: MessageEvent) => {
  if (event.source !== window || event.data?.source !== 'apilens-page-interceptor') return;
  if (event.data.type === 'READY') publishRules();
  if (event.data.type === 'INTERCEPTOR_STATUS') {
    void runtimeApi.runtime.sendMessage({ type: 'INTERCEPTOR_STATUS', status: event.data.status }).catch(() => undefined);
  }
  if (event.data.type === 'MOCK_INTERCEPTED') {
    void runtimeApi.runtime.sendMessage({ type: 'MOCK_INTERCEPTED', request: event.data.request }).catch(() => undefined);
  }
  if (event.data.type === 'SELF_TEST_RESULT' && typeof event.data.requestId === 'string') {
    const pending = pendingSelfTests.get(event.data.requestId);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingSelfTests.delete(event.data.requestId);
      pending.respond(event.data.result);
    }
  }
};

runtimeApi.runtime.onMessage.addListener(runtimeListener);
window.addEventListener('message', pageListener);
bridgeWindow.__APILENS_BRIDGE_CLEANUP__ = () => {
  runtimeApi.runtime.onMessage.removeListener(runtimeListener);
  window.removeEventListener('message', pageListener);
  pendingSelfTests.forEach(pending => {
    window.clearTimeout(pending.timer);
    pending.respond({ ok: false, error: 'The ApiLens bridge was reloaded during the self-test.' });
  });
  pendingSelfTests.clear();
};

void runtimeApi.runtime.sendMessage({ type: 'GET_RULES' }).then(response => {
  if (Array.isArray(response)) {
    // Backward compatibility while an old service worker is being replaced.
    rules = response;
    rulesRevision = '';
  } else if (Array.isArray(response?.rules)) {
    rules = response.rules;
    rulesRevision = typeof response.revision === 'string' ? response.revision : '';
  } else {
    return;
  }
  publishRules();
}).catch(() => undefined);
