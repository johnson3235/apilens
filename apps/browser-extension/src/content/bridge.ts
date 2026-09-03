import type { BridgeToPageMessage, PageToBridgeMessage } from '../shared/messages';
import { extensionApi } from '../shared/browser-api';

/**
 * ISOLATED-world bridge.
 *
 * The MAIN-world hooks cannot touch `chrome.*`, and the service worker cannot
 * touch the page. This bridge is the only channel between them, and it
 * validates every message so a hostile page cannot inject fabricated capture
 * data or trigger extension actions.
 */
interface BridgeWindow extends Window {
  __APILENS_BRIDGE_CLEANUP__?: () => void;
}

const bridgeWindow = window as BridgeWindow;
bridgeWindow.__APILENS_BRIDGE_CLEANUP__?.();

const pendingSelfTests = new Map<string, { respond: (result: unknown) => void; timer: number }>();
let active = true;

function isInvalidContext(error: unknown): boolean {
  return error instanceof Error && /extension context invalidated/i.test(error.message);
}

/**
 * A content script survives in the page after an unpacked extension is
 * reloaded, but every chrome.runtime call then throws synchronously.  Promise
 * `.catch()` cannot catch that throw.  This wrapper handles both synchronous
 * and asynchronous failures and permanently detaches the stale bridge.
 */
async function safeRuntimeMessage<T = unknown>(message: unknown): Promise<T | null> {
  if (!active) return null;
  try {
    return (await extensionApi.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (isInvalidContext(error)) cleanup();
    return null;
  }
}

function toPage(message: BridgeToPageMessage): void {
  window.postMessage(message, window.location.origin === 'null' ? '*' : window.location.origin);
}

async function requestRules(): Promise<void> {
  const response = await safeRuntimeMessage<{
    rules?: unknown; revision?: string; trace?: BridgeToPageMessage['trace']; captureBodies?: boolean; maxBodyBytes?: number; mockingAllowed?: boolean;
  }>({ type: 'bridge:rules' });
  if (!response || !Array.isArray(response.rules) || !active) return;
  try {
    toPage({
      source: 'apilens-bridge',
      type: 'rules',
      rules: response.rules as BridgeToPageMessage['rules'],
      revision: typeof response.revision === 'string' ? response.revision : '',
      mockingAllowed: response.mockingAllowed !== false,
    });
    toPage({
      source: 'apilens-bridge',
      type: 'settings',
      trace: response.trace,
      captureBodies: response.captureBodies !== false,
      maxBodyBytes: typeof response.maxBodyBytes === 'number' ? response.maxBodyBytes : undefined,
      mockingAllowed: response.mockingAllowed !== false,
    });
  } catch { /* The document navigated while rules were being delivered. */ }
}

const runtimeListener = (
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean | undefined => {
  const payload = message as { type?: string; rules?: unknown; revision?: string; mockingAllowed?: boolean; trace?: BridgeToPageMessage['trace']; captureBodies?: boolean; maxBodyBytes?: number };
  if (!payload || typeof payload.type !== 'string') return undefined;

  if (payload.type === 'bridge:push-rules' && Array.isArray(payload.rules)) {
    toPage({
      source: 'apilens-bridge',
      type: 'rules',
      rules: payload.rules as BridgeToPageMessage['rules'],
      revision: payload.revision ?? '',
      mockingAllowed: payload.mockingAllowed !== false,
    });
    sendResponse(true);
    return undefined;
  }

  if (payload.type === 'bridge:push-settings') {
    toPage({
      source: 'apilens-bridge',
      type: 'settings',
      trace: payload.trace,
      captureBodies: payload.captureBodies !== false,
      maxBodyBytes: payload.maxBodyBytes,
      mockingAllowed: payload.mockingAllowed !== false,
    });
    sendResponse(true);
    return undefined;
  }

  if (payload.type === 'bridge:self-test') {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      pendingSelfTests.delete(requestId);
      sendResponse({ ok: false, error: 'The page interceptor did not answer the self-test in time.', testedAt: Date.now() });
    }, 4_000);
    pendingSelfTests.set(requestId, { respond: sendResponse, timer });
    toPage({ source: 'apilens-bridge', type: 'self-test', requestId });
    return true;
  }

  return undefined;
};

const pageListener = (event: MessageEvent): void => {
  if (!active) return;
  if (event.source !== window) return;
  const data = event.data as PageToBridgeMessage | undefined;
  if (!data || data.source !== 'apilens-page') return;

  switch (data.type) {
    case 'ready':
      void requestRules();
      return;
    case 'status':
      if (data.status) void safeRuntimeMessage({ type: 'bridge:status', status: data.status });
      return;
    case 'request':
      if (data.request) void safeRuntimeMessage({ type: 'bridge:request', request: data.request });
      return;
    case 'console':
      void safeRuntimeMessage({ type: 'bridge:console', level: data.level, text: data.text, timestamp: data.timestamp });
      return;
    case 'self-test-result': {
      if (typeof data.requestId !== 'string') return;
      const pending = pendingSelfTests.get(data.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pendingSelfTests.delete(data.requestId);
      pending.respond(data.result);
      return;
    }
    default:
      return;
  }
};

function cleanup(): void {
  if (!active) return;
  active = false;
  try { extensionApi.runtime.onMessage.removeListener(runtimeListener); } catch { /* Runtime is already invalid. */ }
  window.removeEventListener('message', pageListener);
  pendingSelfTests.forEach((pending) => {
    window.clearTimeout(pending.timer);
    try { pending.respond({ ok: false, error: 'The ApiLens bridge reloaded during the self-test.', testedAt: Date.now() }); } catch { /* Response port was invalidated. */ }
  });
  pendingSelfTests.clear();
}

extensionApi.runtime.onMessage.addListener(runtimeListener);
window.addEventListener('message', pageListener);
bridgeWindow.__APILENS_BRIDGE_CLEANUP__ = cleanup;

void requestRules();
