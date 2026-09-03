import type {
  ApiCatalog,
  Bookmark,
  CapturedRequest,
  ContractSet,
  EvidenceScenario,
  RequestMethod,
  RequestType,
  ResponseAssertion,
  Rule,
} from '@apilens/shared-types';
import {
  completeRequest,
  createCapturedRequest,
  createId,
  isStaticAssetPath,
  normalizeHeaders,
  parseUrl,
  resolveEnvironment,
} from '@apilens/core';
import { describeMockingStatus } from '@apilens/mock-engine';
import { redactRequest } from '@apilens/security';
import { enrichWithTraceContext, requestToSpan } from '@apilens/trace-engine';
import { buildCatalog } from '@apilens/insights';
import { buildEvidenceBundle, renderArtifacts } from '@apilens/evidence';
import { executeReplay } from '@apilens/replay-engine';
import { EXTENSION_VERSION, extensionApi, sendRuntimeMessage, sendTabMessage } from '../shared/browser-api';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ExtensionSettings } from '../shared/settings';
import { isTopFrameSynchronized, revisionForRules, type MockEngineHealth } from '../shared/engine-health';
import type { PageHookStatus, PanelEvent, PanelRequest, PanelResponse, PanelState } from '../shared/messages';
import { CaptureStore } from './capture-store';
import { AgentClient } from './agent-client';
import { ChromiumNetworkMock } from './network-mock';
import { RecentRequestBuffer } from './recent-request-buffer';

const RULES_KEY = 'apilens.rules.v1';
const BOOKMARKS_KEY = 'apilens.bookmarks.v1';
const ASSERTIONS_KEY = 'apilens.assertions.v1';
const CONTRACTS_KEY = 'apilens.contracts.v1';
const HEALTH_ALARM = 'apilens-engine-health';
const RETENTION_ALARM = 'apilens-retention';

let settings: ExtensionSettings = DEFAULT_SETTINGS;
let rules: Rule[] = [];
let ruleRevision = revisionForRules(rules);

const frameStatus = new Map<number, Map<number, PageHookStatus>>();
const engineErrors = new Map<number, string>();
const selfTests = new Map<number, { ok: boolean; error?: string; testedAt: number }>();
const consoleMessages = new Map<number, Array<{ level: 'error' | 'warning' | 'info'; text: string; timestamp: number; url: string | null }>>();
const inFlight = new Map<string, CapturedRequest>();
const mockedNetworkIds = new Set<string>();
const recentRequests = new RecentRequestBuffer();

const store = new CaptureStore({
  onRequests: (sessionId, requests) => {
    agent.pushRequests(sessionId, requests);
  },
  onSpans: (_sessionId, spans) => broadcast({ type: 'event:spans', spans }),
});

const agent = new AgentClient({
  onSpans: (_sessionId, spans) => {
    store.addSpans(spans);
  },
  onRequests: (_sessionId, requests) => {
    // Requests observed by the agent's QA proxy — server-side traffic the
    // browser could never see on its own.
    const stored = store.addRequests(requests);
    if (stored.length) broadcast({ type: 'event:requests', tabId: null, requests: stored });
  },
  onStatusChange: (status) => broadcast({ type: 'event:agent', agent: status }),
});

const networkMock = new ChromiumNetworkMock(
  () => rules,
  () => settings.environments,
  {
    onMockedRequest: (tabId, request, networkRequestId) => {
      mockedNetworkIds.add(networkRequestId);
      setTimeout(() => mockedNetworkIds.delete(networkRequestId), 30_000);
      ingest(tabId, request);
    },
    log: (message) => console.warn(`ApiLens: ${message}`),
  },
);

const initialization = Promise.all([loadSettings(), loadRules(), store.restore()]).then(async ([loadedSettings, loadedRules, session]) => {
  settings = loadedSettings;
  rules = loadedRules;
  ruleRevision = revisionForRules(rules);
  if (session) agent.setSessionId(session.id);
  const restoredTrace = await extensionApi.storage.session.get('apilens-tracing-tab');
  tracingTabId = session?.status === 'recording' && typeof restoredTrace['apilens-tracing-tab'] === 'number' ? restoredTrace['apilens-tracing-tab'] : null;
  if (settings.agent.enabled) agent.connect(settings.agent, session?.id ?? null);
});

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

async function loadRules(): Promise<Rule[]> {
  const stored = await extensionApi.storage.local.get(RULES_KEY);
  const value = stored[RULES_KEY];
  return Array.isArray(value) ? (value as Rule[]) : [];
}

async function persistRules(next: Rule[]): Promise<void> {
  rules = next;
  ruleRevision = revisionForRules(next);
  await extensionApi.storage.local.set({ [RULES_KEY]: next });
}

async function readList<T>(key: string): Promise<T[]> {
  const stored = await extensionApi.storage.local.get(key);
  const value = stored[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

/* ------------------------------------------------------------------ */
/* Capture pipeline                                                    */
/* ------------------------------------------------------------------ */

function ingest(tabId: number, request: CapturedRequest): void {
  const enriched = enrichWithTraceContext(request, settings.traceHeaders);
  const environment = resolveEnvironment(enriched.hostname, settings.environments);
  const withEnvironment: CapturedRequest = { ...enriched, environmentId: environment.id, originId: String(tabId) };

  if (!settings.capture.captureStaticAssets && (withEnvironment.type === 'static' || isStaticAssetPath(withEnvironment.path))) {
    return;
  }

  // Redaction runs before anything is stored, broadcast or exported.
  const safe = redactRequest(withEnvironment, settings.redaction);
  recentRequests.add(tabId, safe);
  broadcast({ type: 'event:requests', tabId, requests: [safe] });
  const stored = store.addRequests([safe]);
  if (stored.length === 0) return;

  // A browser request only becomes a span once it has trace identity; the
  // projection keeps browser and server telemetry in one model.
  store.addSpans([requestToSpan(stored[0]!)]);
}

function mapResourceType(type: string): RequestType {
  switch (type) {
    case 'xmlhttprequest':
      return 'xhr';
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
    case 'ping':
      return 'beacon';
    default:
      return 'other';
  }
}

/**
 * `webRequest` sees every request the browser makes, including ones the page
 * hooks cannot reach (service workers, preloads, navigations). It cannot read
 * bodies, so it complements rather than replaces the page hooks.
 */
extensionApi.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!store.isRecording() || details.tabId < 0) return;
    const parsed = parseUrl(details.url);
    inFlight.set(details.requestId, {
      ...createCapturedRequest({
        sessionId: '',
        url: details.url,
        method: (details.method || 'GET').toUpperCase() as RequestMethod,
        channel: 'browser-network',
        source: 'browser',
        type: mapResourceType(details.type),
        originId: String(details.tabId),
        startedAt: details.timeStamp,
      }),
      hostname: parsed.hostname,
      initiator: (details as { initiator?: string }).initiator ?? null,
    });
  },
  { urls: ['<all_urls>'] },
);

extensionApi.webRequest.onSendHeaders.addListener(
  (details) => {
    const record = inFlight.get(details.requestId);
    if (!record || !details.requestHeaders) return;
    inFlight.set(details.requestId, {
      ...record,
      requestHeaders: normalizeHeaders(Object.fromEntries(details.requestHeaders.map((header) => [header.name, header.value ?? '']))),
    });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders'],
);

extensionApi.webRequest.onHeadersReceived.addListener(
  (details) => {
    const record = inFlight.get(details.requestId);
    if (!record || !details.responseHeaders) return;
    inFlight.set(details.requestId, {
      ...record,
      responseHeaders: normalizeHeaders(Object.fromEntries(details.responseHeaders.map((header) => [header.name, header.value ?? '']))),
      statusCode: details.statusCode,
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

extensionApi.webRequest.onCompleted.addListener(
  (details) => {
    const record = inFlight.get(details.requestId);
    inFlight.delete(details.requestId);
    if (!record) return;
    // The page hooks already reported this one with far richer detail.
    if (mockedNetworkIds.delete(details.requestId)) return;
    if (record.type === 'fetch' || record.type === 'xhr') return;
    ingest(details.tabId, completeRequest(record, { statusCode: details.statusCode, completedAt: details.timeStamp }));
  },
  { urls: ['<all_urls>'] },
);

extensionApi.webRequest.onErrorOccurred.addListener(
  (details) => {
    const record = inFlight.get(details.requestId);
    inFlight.delete(details.requestId);
    if (!record) return;
    if (mockedNetworkIds.delete(details.requestId)) return;
    ingest(details.tabId, completeRequest(record, { statusCode: null, error: details.error, completedAt: details.timeStamp }));
  },
  { urls: ['<all_urls>'] },
);

/* ------------------------------------------------------------------ */
/* Engine health                                                       */
/* ------------------------------------------------------------------ */

function healthFor(tabId: number): MockEngineHealth {
  const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
  const frames = [...(frameStatus.get(tabId) ?? new Map<number, PageHookStatus>()).entries()]
    .map(([frameId, status]) => ({ frameId, ...status }))
    .filter((status) => Date.now() - status.updatedAt < 45_000);

  const topFrame = frames.find((frame) => frame.frameId === 0);
  const hooksInstalled = Boolean(topFrame?.installed && topFrame.fetchPatched && topFrame.xhrPatched);
  const rulesSynced = isTopFrameSynchronized(topFrame, enabledRuleCount, ruleRevision);
  const networkMockActive = networkMock.isActive(tabId);
  const pageReady = hooksInstalled && rulesSynced;
  const diagnosticError = (() => {
    if (pageReady || networkMockActive) return null;
    const recorded = engineErrors.get(tabId) ?? networkMock.error(tabId);
    if (recorded) return recorded;
    if (!topFrame) return 'Page hooks were not detected. Reload the target HTTP(S) page, then run Repair & test again.';
    if (!topFrame.installed) return 'The page interceptor is present but did not finish installing.';
    if (!topFrame.fetchPatched || !topFrame.xhrPatched) return 'Fetch or XMLHttpRequest was replaced by the page after ApiLens installed. Run Repair & test.';
    if (!rulesSynced) return `Rules are not synchronized (page ${topFrame.ruleRevision || 'none'}, expected ${ruleRevision}).`;
    return 'The mock engine did not become ready.';
  })();

  return {
    ready: pageReady || networkMockActive,
    engine: pageReady ? 'page-hook' : networkMockActive ? 'chromium-network' : 'none',
    hooksInstalled,
    rulesSynced: rulesSynced || networkMockActive,
    enabledRuleCount,
    expectedRevision: ruleRevision,
    frames,
    networkMockActive,
    lastSelfTest: selfTests.get(tabId) ?? null,
    error: diagnosticError,
  };
}

let tracingTabId: number | null = null;
function traceSettingsFor(tabId: number | null) {
  const session = store.currentSession();
  return {
    enabled: settings.capture.injectTraceHeaders && store.isRecording() && tabId !== null && tabId === tracingTabId,
    sessionId: session?.id ?? null, scenarioId: session?.activeScenarioId ?? null,
    origin: session?.startUrl ? new URL(session.startUrl).origin : null,
  };
}
async function syncTraceSettings(): Promise<void> {
  const tabs = new Set(frameStatus.keys());
  if (tracingTabId !== null) tabs.add(tracingTabId);
  await Promise.all([...tabs].map((tabId) => pushRulesToTab(tabId)));
}
async function pushRulesToTab(tabId: number): Promise<void> {
  const tab = await extensionApi.tabs.get(tabId).catch(() => null);
  const hostname = tab?.url ? parseUrl(tab.url).hostname : '';
  const status = describeMockingStatus(hostname, rules, settings.environments);

  await sendTabMessage(tabId, {
    type: 'bridge:push-rules',
    rules: status.allowed ? rules : [],
    revision: status.allowed ? ruleRevision : revisionForRules([]),
    mockingAllowed: status.allowed,
  });
  await sendTabMessage(tabId, {
    type: 'bridge:push-settings',
    trace: traceSettingsFor(tabId),
    captureBodies: settings.capture.captureBodies,
    maxBodyBytes: settings.capture.maxBodyBytes,
    mockingAllowed: status.allowed,
  });
}

async function reinstallHooks(tabId: number): Promise<void> {
  engineErrors.delete(tabId);
  try {
    await extensionApi.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['content/page-interceptor.js'] });
    await extensionApi.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['content/bridge.js'] });
  } catch (error) {
    engineErrors.set(tabId, error instanceof Error ? error.message : String(error));
    return;
  }

  // Child frames are best-effort: a sandboxed iframe failing must not mark the
  // whole tab unhealthy.
  try {
    await extensionApi.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', files: ['content/page-interceptor.js'] });
    await extensionApi.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', files: ['content/bridge.js'] });
  } catch {
    // Restricted frames are expected and non-fatal.
  }
}

async function ensureEngine(tabId: number): Promise<MockEngineHealth> {
  await reinstallHooks(tabId);
  await pushRulesToTab(tabId);

  const deadline = Date.now() + 1_500;
  let health = healthFor(tabId);
  while (!health.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    health = healthFor(tabId);
  }

  if (!health.ready && rules.some((rule) => rule.enabled)) {
    const network = await networkMock.enable(tabId);
    if (!network.active && network.error) engineErrors.set(tabId, network.error);
    health = healthFor(tabId);
  }

  return health;
}

async function runSelfTest(tabId: number): Promise<{ ok: boolean; error?: string; testedAt: number }> {
  const health = healthFor(tabId);
  if (health.engine === 'chromium-network') {
    const result = { ok: true, testedAt: Date.now() };
    selfTests.set(tabId, result);
    return result;
  }
  const result = (await sendTabMessage<{ ok: boolean; error?: string; testedAt: number }>(tabId, { type: 'bridge:self-test' })) ?? {
    ok: false,
    error: 'The page did not respond to the self-test.',
    testedAt: Date.now(),
  };
  selfTests.set(tabId, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

async function buildState(tabId: number | null): Promise<PanelState> {
  const tab = tabId !== null ? await extensionApi.tabs.get(tabId).catch(() => null) : null;
  const hostname = tab?.url ? parseUrl(tab.url).hostname : '';
  const mocking = describeMockingStatus(hostname, rules, settings.environments);
  const environment = resolveEnvironment(hostname, settings.environments);

  return {
    version: EXTENSION_VERSION,
    session: store.currentSession(),
    recording: store.isRecording(),
    settings,
    rules,
    agent: agent.getStatus(),
    engine: tabId !== null ? healthFor(tabId) : null,
    environmentId: environment.id,
    environmentName: environment.name,
    mockingAllowed: mocking.allowed,
    mockingBlockedReason: mocking.reason,
    pageUrl: tab?.url ?? null,
  };
}

function broadcast(event: PanelEvent): void {
  void sendRuntimeMessage(event);
}

async function broadcastState(tabId: number | null): Promise<void> {
  broadcast({ type: 'event:state', state: await buildState(tabId) });
}

/* ------------------------------------------------------------------ */
/* Message routing                                                     */
/* ------------------------------------------------------------------ */

async function handlePanelRequest(message: PanelRequest, senderTabId: number | null): Promise<PanelResponse> {
  switch (message.type) {
    case 'state:get':
      return { ok: true, state: await buildState(message.tabId ?? senderTabId) };

    case 'requests:get': {
      const sessionId = message.sessionId ?? store.currentSession()?.id ?? null;
      if (!sessionId) return { ok: true, requests: [] };
      return { ok: true, requests: await store.requestsFor(sessionId) };
    }

    case 'recent:get': {
      const tabId = message.tabId ?? senderTabId;
      if (tabId === null) return { ok: true, requests: [] };
      return { ok: true, requests: recentRequests.get(tabId) };
    }

    case 'requests:clear':
      await store.clearCurrent();
      return { ok: true };

    case 'spans:get': {
      const sessionId = message.sessionId ?? store.currentSession()?.id ?? null;
      if (!sessionId) return { ok: true, spans: [] };
      return { ok: true, spans: await store.spansFor(sessionId) };
    }

    case 'rules:get':
      return { ok: true, rules };

    case 'rules:set': {
      await persistRules(message.rules);
      const session = store.currentSession();
      if (session) agent.syncRules(session.id, message.rules);
      const tabId = message.tabId ?? senderTabId;
      if (tabId !== null) {
        await pushRulesToTab(tabId);
        if (message.rules.some((rule) => rule.enabled)) await ensureEngine(tabId);
        else await networkMock.disable(tabId);
      }
      await broadcastState(tabId);
      return { ok: true, rules: message.rules };
    }

    case 'settings:get':
      return { ok: true, settings };

    case 'settings:set': {
      settings = message.settings;
      await saveSettings(settings);
      if (settings.agent.enabled) agent.connect(settings.agent, store.currentSession()?.id ?? null);
      else agent.disconnect();
      await syncTraceSettings();
      await broadcastState(senderTabId);
      return { ok: true, settings };
    }

    case 'session:start': {
      const tabId = message.tabId ?? senderTabId;
      const tab = tabId !== null ? await extensionApi.tabs.get(tabId).catch(() => null) : null;
      const hostname = tab?.url ? parseUrl(tab.url).hostname : '';
      const session = await store.startSession({
        name: message.name,
        startUrl: tab?.url ?? null,
        environmentId: resolveEnvironment(hostname, settings.environments).id,
        userAgent: navigator.userAgent,
      });
      agent.setSessionId(session.id);
      agent.startSession(session);
      tracingTabId = tabId;
      await extensionApi.storage.session.set({ 'apilens-tracing-tab': tabId });
      await syncTraceSettings();
      if (tabId !== null) consoleMessages.delete(tabId);
      await broadcastState(tabId);
      return { ok: true, state: await buildState(tabId) };
    }

    case 'session:stop': {
      const session = await store.stopSession();
      await syncTraceSettings();
      tracingTabId = null;
      await extensionApi.storage.session.remove('apilens-tracing-tab');
      if (session) agent.stopSession(session.id);
      await store.enforceRetention(settings.retention);
      await broadcastState(senderTabId);
      return { ok: true, state: await buildState(senderTabId) };
    }

    case 'session:marker': {
      const session = store.currentSession();
      if (!session) return { ok: false, error: 'No session is recording.' };
      await store.updateSession({ markers: [...session.markers, message.marker] });
      return { ok: true };
    }

    case 'session:evidence:set': {
      const session = store.currentSession();
      if (!session) return { ok: false, error: 'Start an evidence recording first.' };
      const title = message.title.trim().slice(0, 160);
      if (!title) return { ok: false, error: 'Test evidence title is required.' };
      const scenarios: EvidenceScenario[] = message.scenarios.slice(0, 50).map((scenario) => ({
        ...scenario,
        title: scenario.title.trim().slice(0, 160),
        expectedResult: scenario.expectedResult.trim().slice(0, 2_000),
        actualResult: scenario.actualResult.trim().slice(0, 2_000),
        notes: scenario.notes.trim().slice(0, 2_000),
      })).filter((scenario) => Boolean(scenario.id && scenario.title));
      const activeScenarioId = message.activeScenarioId && scenarios.some((scenario) => scenario.id === message.activeScenarioId)
        ? message.activeScenarioId
        : null;
      await store.updateSession({ name: title, scenarios, activeScenarioId });
      await syncTraceSettings();
      await broadcastState(senderTabId);
      return { ok: true, state: await buildState(senderTabId) };
    }

    case 'session:screenshot': {
      const session = store.currentSession();
      if (!session || session.status !== 'recording') return { ok: false, error: 'Start evidence recording before taking a screenshot.' };
      const tabId = message.tabId ?? senderTabId;
      if (tabId === null) return { ok: false, error: 'No active web page is available for screenshot capture.' };
      const tab = await extensionApi.tabs.get(tabId).catch(() => null);
      if (!tab || tab.windowId === undefined) return { ok: false, error: 'The active browser tab could not be captured.' };
      if (message.scenarioId && !(session.scenarios ?? []).some((scenario) => scenario.id === message.scenarioId)) {
        return { ok: false, error: 'Select a valid scenario before taking a screenshot.' };
      }
      try {
        const resourceRef = await extensionApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const screenshotCount = session.markers.filter((marker) => marker.kind === 'screenshot').length;
        const marker = {
          id: createId(),
          kind: 'screenshot' as const,
          label: message.label.trim().slice(0, 160) || `Screenshot ${screenshotCount + 1}`,
          timestamp: Date.now(),
          detail: tab.url ?? null,
          resourceRef,
          scenarioId: message.scenarioId,
        };
        await store.updateSession({ markers: [...session.markers, marker] });
        await broadcastState(tabId);
        return { ok: true, state: await buildState(tabId) };
      } catch (error) {
        return { ok: false, error: `Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    case 'session:list':
      return { ok: true, sessions: await store.listSessions() };

    case 'session:load': {
      const session = await store.getSession(message.sessionId);
      if (!session) return { ok: false, error: 'That session no longer exists.' };
      return { ok: true, requests: await store.requestsFor(message.sessionId) };
    }

    case 'session:delete':
      await store.deleteSession(message.sessionId);
      return { ok: true };

    case 'session:clearAll':
      await store.clearAll();
      await broadcastState(senderTabId);
      return { ok: true };

    case 'engine:health': {
      const tabId = message.tabId ?? senderTabId;
      if (tabId === null) return { ok: false, error: 'No inspected tab is available.' };
      await pushRulesToTab(tabId);
      return { ok: true, health: healthFor(tabId) };
    }

    case 'engine:repair': {
      const tabId = message.tabId ?? senderTabId;
      if (tabId === null) return { ok: false, error: 'No inspected tab is available.' };
      frameStatus.delete(tabId);
      const health = await ensureEngine(tabId);
      const selfTest = health.ready ? await runSelfTest(tabId) : { ok: false, error: health.error ?? 'No mock engine could be installed.', testedAt: Date.now() };
      return { ok: true, health: { ...healthFor(tabId), ready: health.ready && selfTest.ok, lastSelfTest: selfTest } };
    }

    case 'replay:execute': {
      const session = store.currentSession();
      if (message.viaAgent) {
        if (!agent.isConnected()) return { ok: false, error: 'The QA agent is not connected, so a server-side replay is not possible.' };
        try {
          const response = await agent.replay(session?.id ?? '', message.originalRequestId, message.request);
          return { ok: true, response };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      const response = await executeReplay(message.request, { executedBy: 'extension', maxBodyBytes: settings.capture.maxBodyBytes });
      return { ok: true, response };
    }

    case 'evidence:export': {
      const session = await store.getSession(message.sessionId);
      if (!session) return { ok: false, error: 'That session no longer exists.' };

      const requests = await store.requestsFor(message.sessionId);
      const spans = await store.spansFor(message.sessionId);
      const bundle = buildEvidenceBundle({
        session,
        requests,
        spans,
        rules,
        environment: {
          environmentId: session.environmentId,
          environmentName: session.environmentId,
          browser: navigator.userAgent,
          userAgent: session.userAgent,
          platform: navigator.platform,
          extensionVersion: EXTENSION_VERSION,
          agentVersion: agent.getStatus().agentVersion,
        },
        consoleMessages: [...consoleMessages.values()].flat().map((entry) => ({ ...entry, url: entry.url })),
        assertions: await readList<ResponseAssertion>(ASSERTIONS_KEY),
        contracts: await readList<ContractSet>(CONTRACTS_KEY),
        redactionPolicy: settings.redaction,
        options: message.options,
      });

      const artifacts = renderArtifacts(bundle, message.options);
      return { ok: true, files: artifacts.map((artifact) => ({ format: artifact.contentType, name: artifact.fileName, content: artifact.content })) };
    }

    case 'agent:status':
      return { ok: true, agent: agent.getStatus() };

    case 'agent:connect':
      agent.connect(settings.agent, store.currentSession()?.id ?? null);
      return { ok: true, agent: agent.getStatus() };

    case 'agent:disconnect':
      agent.disconnect();
      return { ok: true, agent: agent.getStatus() };

    case 'bookmarks:get':
      return { ok: true, bookmarks: await readList<Bookmark>(BOOKMARKS_KEY) };

    case 'bookmarks:set':
      await extensionApi.storage.local.set({ [BOOKMARKS_KEY]: message.bookmarks });
      return { ok: true, bookmarks: message.bookmarks };

    case 'catalog:get': {
      const sessionId = store.currentSession()?.id;
      const requests = sessionId ? await store.requestsFor(sessionId) : [];
      const catalog: ApiCatalog = buildCatalog(requests);
      return { ok: true, catalog };
    }

    case 'assertions:get':
      return { ok: true, assertions: await readList<ResponseAssertion>(ASSERTIONS_KEY) };

    case 'assertions:set':
      await extensionApi.storage.local.set({ [ASSERTIONS_KEY]: message.assertions });
      return { ok: true, assertions: message.assertions };

    case 'contracts:get':
      return { ok: true, contracts: await readList<ContractSet>(CONTRACTS_KEY) };

    case 'contracts:set':
      await extensionApi.storage.local.set({ [CONTRACTS_KEY]: message.contracts });
      return { ok: true, contracts: message.contracts };

    default:
      return { ok: false, error: `Unsupported request "${(message as { type: string }).type}".` };
  }
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const payload = message as { type?: string } | undefined;
  if (!payload || typeof payload.type !== 'string') return undefined;
  const senderTabId = sender.tab?.id ?? null;

  /* Bridge traffic from content scripts. */
  if (payload.type === 'bridge:rules') {
    void (async () => {
      await initialization;
      const hostname = sender.tab?.url ? parseUrl(sender.tab.url).hostname : '';
      const status = describeMockingStatus(hostname, rules, settings.environments);
      sendResponse({
        rules: status.allowed ? rules : [],
        revision: status.allowed ? ruleRevision : revisionForRules([]),
        trace: traceSettingsFor(senderTabId),
        captureBodies: settings.capture.captureBodies,
        maxBodyBytes: settings.capture.maxBodyBytes,
        mockingAllowed: status.allowed,
      });
    })();
    return true;
  }

  if (payload.type === 'bridge:status') {
    if (senderTabId !== null) {
      const frames = frameStatus.get(senderTabId) ?? new Map<number, PageHookStatus>();
      frames.set(sender.frameId ?? 0, (payload as { status: PageHookStatus }).status);
      frameStatus.set(senderTabId, frames);
    }
    sendResponse(true);
    return undefined;
  }

  if (payload.type === 'bridge:request') {
    void initialization.then(() => {
      if (senderTabId !== null) ingest(senderTabId, (payload as { request: CapturedRequest }).request);
      sendResponse(true);
    });
    return true;
  }

  if (payload.type === 'bridge:console') {
    if (senderTabId !== null) {
      const entry = payload as { level: 'error' | 'warning' | 'info'; text: string; timestamp: number };
      const bucket = consoleMessages.get(senderTabId) ?? [];
      bucket.push({ level: entry.level, text: entry.text, timestamp: entry.timestamp, url: sender.tab?.url ?? null });
      consoleMessages.set(senderTabId, bucket.slice(-200));
      broadcast({ type: 'event:console', tabId: senderTabId, level: entry.level, text: entry.text, timestamp: entry.timestamp });
    }
    sendResponse(true);
    return undefined;
  }

  /* Panel and popup requests. */
  void initialization.then(() => handlePanelRequest(payload as PanelRequest, senderTabId))
    .then(sendResponse)
    .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

extensionApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !/^https?:/i.test(tab.url ?? '')) return;
  void initialization.then(async () => {
    frameStatus.delete(tabId);
    selfTests.delete(tabId);
    await pushRulesToTab(tabId);
    if (rules.some((rule) => rule.enabled)) await ensureEngine(tabId);

    const session = store.currentSession();
    if (session?.status === 'recording' && tab.url) {
      await store.updateSession({
        markers: [
          ...session.markers,
          { id: `${tabId}-${Date.now()}`, kind: 'navigation', label: tab.url, timestamp: Date.now(), detail: null, resourceRef: null },
        ],
      });
    }
  }).catch((error: unknown) => {
    engineErrors.set(tabId, error instanceof Error ? error.message : String(error));
  });
});

extensionApi.tabs.onRemoved.addListener((tabId) => {
  frameStatus.delete(tabId);
  engineErrors.delete(tabId);
  selfTests.delete(tabId);
  consoleMessages.delete(tabId);
  recentRequests.clear(tabId);
  void networkMock.disable(tabId);
});

extensionApi.alarms.create(HEALTH_ALARM, { periodInMinutes: 0.5 });
extensionApi.alarms.create(RETENTION_ALARM, { periodInMinutes: 60 });

extensionApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETENTION_ALARM) {
    void store.enforceRetention(settings.retention);
    return;
  }
  if (alarm.name !== HEALTH_ALARM) return;

  // Flushing on the health tick guarantees buffered captures reach IndexedDB
  // before MV3 suspends the worker.
  void store.flush();
  if (!rules.some((rule) => rule.enabled)) return;

  void extensionApi.tabs.query({ active: true }).then((tabs) => {
    tabs
      .filter((tab) => tab.id !== undefined && /^https?:/i.test(tab.url ?? ''))
      .forEach((tab) => {
        if (!healthFor(tab.id!).ready) void ensureEngine(tab.id!);
      });
  });
});

extensionApi.runtime.onSuspend?.addListener(() => {
  void store.flush();
  void networkMock.disableAll();
});
