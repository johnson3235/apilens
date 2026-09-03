import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CapturedRequest, EvidenceScenario, EvidenceScenarioStatus, Rule, RuleAction } from '@apilens/shared-types';
import type { PanelEvent, PanelState } from '../shared/messages';
import { EXTENSION_VERSION, extensionApi } from '../shared/browser-api';
import { summariseHealth } from '../shared/engine-health';
import { isMixedBuild, isUnsupportedRecentRequest, selectActiveWebTabId } from './popup-compat';
import { withTemporaryHostOverride } from './temporary-host-override';
import { buildCustomMockAction, findRequestCandidates, type KeywordLogic } from './mock-builder';
import { createEvidenceScenario, screenshotCount, setEvidenceScenarioStatus } from './evidence-workflow';

import { CapturedHeaders } from '../shared/CapturedHeaders';

type PopupTab = 'overview' | 'requests' | 'mocks' | 'evidence' | 'tools';
type MockPreset = '500' | '429' | 'timeout' | 'slow';
type MockMode = 'preset' | 'custom';
const presets: Array<{ id: MockPreset; label: string; detail: string; action: RuleAction }> = [
  { id: '500', label: '500', detail: 'Server error', action: { type: 'status-code', statusCode: 500 } },
  { id: '429', label: '429', detail: 'Rate limited', action: { type: 'rate-limit' } },
  { id: 'timeout', label: 'Timeout', detail: 'No response', action: { type: 'timeout' } },
  { id: 'slow', label: '+3s', detail: 'Slow response', action: { type: 'slow-response', delayMs: 3_000 } },
];

async function activeTabId(): Promise<number | null> {
  const current = await extensionApi.tabs.query({ active: true, currentWindow: true });
  const focused = await extensionApi.tabs.query({ active: true, lastFocusedWindow: true });
  return selectActiveWebTabId(current, focused);
}

async function sendChecked<T extends { ok: boolean; error?: string }>(message: unknown): Promise<T> {
  const response = await extensionApi.runtime.sendMessage(message) as T | undefined;
  if (!response?.ok) throw new Error(response?.error ?? 'The extension background service did not complete the action.');
  return response;
}

function downloadFile(name: string, contentType: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: contentType }));
  const link = document.createElement('a');
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

function Popup(): JSX.Element {
  const [tab, setTab] = useState<PopupTab>('overview');
  const [state, setState] = useState<PanelState | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preset, setPreset] = useState<MockPreset>('500');
  const [mockMode, setMockMode] = useState<MockMode>('preset');
  const [keywordOne, setKeywordOne] = useState('');
  const [keywordTwo, setKeywordTwo] = useState('');
  const [keywordLogic, setKeywordLogic] = useState<KeywordLogic>('and');
  const [customStatus, setCustomStatus] = useState('500');
  const [customBody, setCustomBody] = useState('{\n  "error": "Simulated by ApiLens"\n}');
  const [customContentType, setCustomContentType] = useState<'application/json' | 'text/plain'>('application/json');
  const [evidenceTitle, setEvidenceTitle] = useState('Clear Mobile Test Evidence');
  const [scenarioTitle, setScenarioTitle] = useState('');
  const [scenarioExpected, setScenarioExpected] = useState('');
  const [screenshotLabel, setScreenshotLabel] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [buildMismatch, setBuildMismatch] = useState(false);
  const activeTabRef = useRef<number | null>(null);
  const evidenceSessionIdRef = useRef<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const tabId = await activeTabId();
      activeTabRef.current = tabId;
      const response = await sendChecked<{ ok: true; state: PanelState }>({ type: 'state:get', tabId });
      const mismatch = isMixedBuild(EXTENSION_VERSION, response.state.version);
      setBuildMismatch(mismatch);
      let requestResponse = await extensionApi.runtime.sendMessage({ type: 'recent:get', tabId }) as { ok: boolean; requests?: CapturedRequest[]; error?: string } | undefined;
      if (isUnsupportedRecentRequest(requestResponse)) {
        requestResponse = await extensionApi.runtime.sendMessage({ type: 'requests:get', tabId, sessionId: response.state.session?.id ?? null }) as typeof requestResponse;
        setBuildMismatch(true);
      }
      if (!requestResponse?.ok) throw new Error(requestResponse?.error ?? 'Requests could not be loaded.');
      setState(response.state); setRequests(requestResponse.requests ?? []); setError(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  async function action(name: string, task: () => Promise<void>, success: string): Promise<void> {
    setBusy(name); setError(null); setNotice(null);
    try { await task(); await refresh(); setNotice(success); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(null); }
  }

  useEffect(() => {
    void refresh();
    const listener = (message: unknown): void => {
      const event = message as PanelEvent;
      if (event.type === 'event:requests' && event.tabId === activeTabRef.current) setRequests((previous) => [...new Map([...previous, ...event.requests].map((request) => [request.id, request])).values()].slice(-100));
      if (event.type === 'event:state') setState(event.state);
      if (event.type === 'event:agent') setState((previous) => previous ? { ...previous, agent: event.agent } : previous);
    };
    extensionApi.runtime.onMessage.addListener(listener);
    return () => extensionApi.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    const sessionId = state?.session?.id ?? null;
    if (sessionId === evidenceSessionIdRef.current) return;
    evidenceSessionIdRef.current = sessionId;
    if (state?.session?.name) setEvidenceTitle(state.session.name);
  }, [state?.session?.id, state?.session?.name]);

  const repair = () => action('repair', async () => { await sendChecked({ type: 'engine:repair', tabId: await activeTabId() }); }, 'Page hooks repaired and checked.');
  const toggleSession = () => action('session', async () => {
    if (state?.recording) await sendChecked({ type: 'session:stop' });
    else await sendChecked({ type: 'session:start', name: `QA journey · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, tabId: await activeTabId() });
  }, state?.recording ? 'Session stopped. Evidence is ready for review.' : 'QA session started. Reproduce the journey now.');

  const toggleRule = (rule: Rule) => action(`rule-${rule.id}`, async () => {
    const rules = state?.rules.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item) ?? [];
    await sendChecked({ type: 'rules:set', rules, tabId: await activeTabId() });
  }, `${rule.name} ${rule.enabled ? 'disabled' : 'enabled'}.`);

  const createMock = () => action('create-mock', async () => {
    const request = requests.find((item) => item.id === selectedId);
    const chosen = presets.find((item) => item.id === preset);
    if (!request) throw new Error('Select a captured request to mock.');
    if (mockMode === 'preset' && !chosen) throw new Error('Select a failure preset.');
    if (!state?.mockingAllowed) throw new Error(state?.mockingBlockedReason ?? 'Mocking is blocked in this environment.');
    const now = Date.now();
    const mockAction = mockMode === 'custom'
      ? buildCustomMockAction({ statusCode: customStatus, responseBody: customBody, contentType: customContentType })
      : chosen!.action;
    const mockLabel = mockMode === 'custom' ? `Custom ${customStatus}` : chosen!.label;
    const rule: Rule = { id: crypto.randomUUID(), scenarioId: null, name: `${mockLabel} · ${request.method} ${request.path}`, description: `${mockMode === 'custom' ? 'Custom response' : 'Quick mock'} created from captured request ${request.id}.`, enabled: true, priority: 100, conditions: [{ field: 'url', operator: 'equals', value: request.url }, { field: 'method', operator: 'equals', value: request.method }], conditionLogic: 'and', action: mockAction, applyMode: 'always', appliedCount: 0, environments: state.environmentId ? [state.environmentId] : [], createdAt: now, updatedAt: now };
    await sendChecked({ type: 'rules:set', rules: [...state.rules, rule], tabId: await activeTabId() });
  }, 'Exact-match mock enabled. Repeat the UI action to test it.');

  const grantTemporaryOverride = () => action('override', async () => {
    if (!state?.pageUrl) throw new Error('No active web page was detected.');
    const hostname = new URL(state.pageUrl).hostname.toLowerCase();
    await sendChecked({ type: 'settings:set', settings: withTemporaryHostOverride(state.settings, hostname) });
  }, 'Mocking enabled for this exact hostname for 10 minutes.');

  const exportEvidence = () => action('evidence', async () => {
    if (!state?.session) throw new Error('Start a QA session before exporting evidence.');
    const response = await extensionApi.runtime.sendMessage({ type: 'evidence:export', sessionId: state.session.id, options: { formats: ['html', 'json', 'har', 'markdown'] } }) as { ok: boolean; files?: Array<{ format: string; name: string; content: string }>; error?: string };
    if (!response.ok || !response.files) throw new Error(response.error ?? 'Evidence could not be generated.');
    response.files.forEach((file) => downloadFile(file.name, file.format, file.content));
  }, 'Evidence exported in HTML, HAR, JSON and Markdown.');

  const startEvidence = () => action('evidence-start', async () => {
    const title = evidenceTitle.trim();
    if (!title) throw new Error('Add a title for this test evidence.');
    await sendChecked({ type: 'session:start', name: title, tabId: await activeTabId() });
  }, 'Evidence recording started. Add or activate a scenario, then capture proof.');

  const saveEvidenceStructure = (scenarios: EvidenceScenario[], activeScenarioId: string | null, success: string) => action('evidence-save', async () => {
    if (!state?.session) throw new Error('Start evidence recording first.');
    await sendChecked({ type: 'session:evidence:set', title: evidenceTitle, scenarios, activeScenarioId });
  }, success);

  const addEvidenceScenario = () => {
    if (!state?.session) return;
    const scenario = createEvidenceScenario(scenarioTitle, scenarioExpected);
    setScenarioTitle(''); setScenarioExpected('');
    void saveEvidenceStructure([...(state.session.scenarios ?? []), scenario], scenario.id, 'Scenario added and recording is active for it.');
  };

  const changeScenarioStatus = (scenarioId: string, status: EvidenceScenarioStatus) => {
    if (!state?.session) return;
    const scenarios = setEvidenceScenarioStatus(state.session.scenarios ?? [], scenarioId, status);
    const activeScenarioId = status === 'in-progress' ? scenarioId : state.session.activeScenarioId === scenarioId ? null : state.session.activeScenarioId ?? null;
    void saveEvidenceStructure(scenarios, activeScenarioId, status === 'in-progress' ? 'Scenario is now receiving evidence.' : `Scenario marked ${status}.`);
  };

  const updateScenarioActual = (scenarioId: string, actualResult: string) => {
    if (!state?.session) return;
    const scenarios = (state.session.scenarios ?? []).map((scenario) => scenario.id === scenarioId ? { ...scenario, actualResult } : scenario);
    void saveEvidenceStructure(scenarios, state.session.activeScenarioId ?? null, 'Actual result saved.');
  };

  const captureScreenshot = () => action('screenshot', async () => {
    const scenarioId = state?.session?.activeScenarioId ?? null;
    if (!scenarioId) throw new Error('Activate a scenario before taking a screenshot.');
    await sendChecked({ type: 'session:screenshot', tabId: await activeTabId(), label: screenshotLabel, scenarioId });
    setScreenshotLabel('');
  }, 'Screenshot attached to the active scenario.');

  const ready = state?.engine?.ready === true;
  const supported = state?.pageUrl?.startsWith('http') === true;
  const failed = requests.filter((request) => request.error || (request.statusCode ?? 0) >= 400).length;
  const visibleRequests = useMemo(() => requests.filter((request) => `${request.method} ${request.url} ${request.statusCode ?? ''}`.toLowerCase().includes(query.toLowerCase())).slice(-30).reverse(), [requests, query]);
  const selected = requests.find((request) => request.id === selectedId) ?? null;

  return <main className="popup-shell">
    <header className="popup-header"><div className="popup-brand"><span className="brand-mark" aria-hidden="true">A</span><div><strong>ApiLens</strong><small>QA Command Center · v{EXTENSION_VERSION}</small></div></div><div className="header-live"><span className={ready ? 'on' : ''} />{ready ? 'Ready' : 'Check engine'}</div></header>
    <nav className="popup-tabs" aria-label="Popup features">{(['overview','requests','mocks','evidence','tools'] as PopupTab[]).map((item) => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item === 'mocks' ? 'Mock' : item[0].toUpperCase() + item.slice(1)}{item === 'requests' && requests.length ? <b>{requests.length}</b> : null}</button>)}</nav>

    <div className="popup-content">
      {buildMismatch ? <section className="update-banner" role="alert"><div><strong>Finish applying the ApiLens update</strong><span>The popup and background service are different versions.</span></div><button onClick={() => extensionApi.runtime.reload()}>Reload extension</button></section> : null}
      {tab === 'overview' ? <Overview state={state} ready={ready} supported={supported} requests={requests.length} failed={failed} busy={busy} onRepair={() => void repair()} onSession={() => void toggleSession()} onTab={setTab} /> : null}
      {tab === 'requests' ? <RequestsView requests={visibleRequests} query={query} setQuery={setQuery} selectedId={selectedId} onSelect={(request) => setSelectedId(request.id)} onMock={(request) => { setSelectedId(request.id); setTab('mocks'); }} onRefresh={() => void refresh()} /> : null}
      {tab === 'mocks' ? <MocksView state={state} selected={selected} requests={requests} selectedId={selectedId} setSelectedId={setSelectedId} preset={preset} setPreset={setPreset} mockMode={mockMode} setMockMode={setMockMode} keywordOne={keywordOne} setKeywordOne={setKeywordOne} keywordTwo={keywordTwo} setKeywordTwo={setKeywordTwo} keywordLogic={keywordLogic} setKeywordLogic={setKeywordLogic} customStatus={customStatus} setCustomStatus={setCustomStatus} customBody={customBody} setCustomBody={setCustomBody} customContentType={customContentType} setCustomContentType={setCustomContentType} busy={busy} onCreate={() => void createMock()} onGrant={() => void grantTemporaryOverride()} onToggle={(rule) => void toggleRule(rule)} onRequests={() => setTab('requests')} /> : null}
      {tab === 'evidence' ? <EvidenceView state={state} requests={requests} failed={failed} busy={busy} evidenceTitle={evidenceTitle} setEvidenceTitle={setEvidenceTitle} scenarioTitle={scenarioTitle} setScenarioTitle={setScenarioTitle} scenarioExpected={scenarioExpected} setScenarioExpected={setScenarioExpected} screenshotLabel={screenshotLabel} setScreenshotLabel={setScreenshotLabel} onStart={() => void startEvidence()} onStop={() => void toggleSession()} onSaveTitle={() => void saveEvidenceStructure(state?.session?.scenarios ?? [], state?.session?.activeScenarioId ?? null, 'Evidence title saved.')} onAddScenario={addEvidenceScenario} onScenarioStatus={changeScenarioStatus} onActualResult={updateScenarioActual} onScreenshot={() => void captureScreenshot()} onExport={() => void exportEvidence()} /> : null}
      {tab === 'tools' ? <ToolsView state={state} onRepair={() => void repair()} onTab={setTab} busy={busy} /> : null}
    </div>
    {notice ? <p className="popup-notice" role="status">✓ {notice}</p> : null}{error ? <p className="error-card popup-error" role="alert">{error}</p> : null}
    <footer className="popup-footer"><span>{state?.pageUrl ? new URL(state.pageUrl).hostname : 'Open a web application to begin'}</span><button onClick={() => void refresh()} disabled={busy !== null}>Refresh</button></footer>
  </main>;
}

function Overview({ state, ready, supported, requests, failed, busy, onRepair, onSession, onTab }: { state: PanelState | null; ready: boolean; supported: boolean; requests: number; failed: number; busy: string | null; onRepair: () => void; onSession: () => void; onTab: (tab: PopupTab) => void }): JSX.Element {
  return <div className="popup-view"><section className="command-hero"><span className="popup-overline">{state?.environmentName ?? 'CURRENT APPLICATION'}</span><h1>{state?.recording ? 'Journey capture is live' : 'Test, break, debug, prove.'}</h1><p>{state?.recording ? 'Perform the scenario now. Requests are appearing live in the tracker.' : 'A focused QA workspace for the active browser tab.'}</p><button className={`session-button ${state?.recording ? 'stop' : ''}`} onClick={onSession} disabled={!supported || busy === 'session'}><span />{state?.recording ? 'Stop & review' : 'Start QA session'}</button></section><div className="overview-metrics"><button onClick={() => onTab('requests')}><strong>{requests}</strong><span>Requests</span></button><button onClick={() => onTab('requests')}><strong className={failed ? 'danger-text' : ''}>{failed}</strong><span>Failed</span></button><button onClick={() => onTab('mocks')}><strong>{state?.rules.filter((rule) => rule.enabled).length ?? 0}</strong><span>Mocks on</span></button></div><section className={`popup-health ${ready ? 'healthy' : ''}`}><span className="health-icon">{ready ? '✓' : '!'}</span><div><strong>{state?.engine ? summariseHealth(state.engine) : 'Checking engine…'}</strong><span>{ready ? 'Fetch and XHR hooks connected' : 'Repair before controlled failure testing'}</span></div><button onClick={onRepair}>{busy === 'repair' ? 'Checking…' : ready ? 'Recheck' : 'Repair'}</button></section><section className="next-actions"><span className="popup-overline">FAST WORKFLOWS</span><div><button onClick={() => onTab('requests')}><b>↗</b><span><strong>Inspect live traffic</strong><small>Methods, status and timing</small></span></button><button onClick={() => onTab('mocks')}><b>⚡</b><span><strong>Create quick mock</strong><small>500, 429, timeout or delay</small></span></button><button onClick={() => onTab('tools')}><b>◎</b><span><strong>Explore all tools</strong><small>Tracing, evidence and SDK</small></span></button></div></section></div>;
}

function RequestsView({ requests, query, setQuery, selectedId, onSelect, onMock, onRefresh }: { requests: CapturedRequest[]; query: string; setQuery: (value: string) => void; selectedId: string | null; onSelect: (request: CapturedRequest) => void; onMock: (request: CapturedRequest) => void; onRefresh: () => void }): JSX.Element {
  const selected = requests.find((request) => request.id === selectedId);
  return <div className="popup-view"><div className="view-title"><div><span className="popup-overline">LIVE TRACKER</span><h1>Recent requests</h1></div><button onClick={onRefresh}>Refresh</button></div><input className="popup-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter URL, method or status…" aria-label="Filter requests" />{requests.length ? <div className="request-feed">{requests.map((request) => <article key={request.id} className={selectedId === request.id ? 'selected' : ''} tabIndex={0} role="button" aria-label={`Inspect ${request.method} ${request.path}`} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onSelect(request); } }} onClick={() => onSelect(request)}><span className={`method method-${request.method.toLowerCase()}`}>{request.method}</span><div><strong title={request.url}>{request.path}</strong><small>{request.hostname} · {request.timing.durationMs === null ? 'pending' : `${Math.round(request.timing.durationMs)} ms`}</small></div><span className={`feed-status ${(request.statusCode ?? 0) >= 400 || request.error ? 'bad' : ''}`}>{request.error ? 'ERR' : request.statusCode ?? '…'}</span><button onClick={(event) => { event.stopPropagation(); onMock(request); }}>Mock</button></article>)}</div> : <Empty title="No requests yet" copy="Start a QA session, reload the page, and perform an action." />}{selected ? <CapturedHeaders requestHeaders={selected.requestHeaders} responseHeaders={selected.responseHeaders} /> : <p>Select a request to inspect its headers.</p>}</div>;
}

interface MocksViewProps {
  state: PanelState | null; selected: CapturedRequest | null; requests: CapturedRequest[]; selectedId: string | null;
  setSelectedId: (id: string) => void; preset: MockPreset; setPreset: (preset: MockPreset) => void;
  mockMode: MockMode; setMockMode: (mode: MockMode) => void;
  keywordOne: string; setKeywordOne: (value: string) => void; keywordTwo: string; setKeywordTwo: (value: string) => void;
  keywordLogic: KeywordLogic; setKeywordLogic: (logic: KeywordLogic) => void;
  customStatus: string; setCustomStatus: (value: string) => void; customBody: string; setCustomBody: (value: string) => void;
  customContentType: 'application/json' | 'text/plain'; setCustomContentType: (value: 'application/json' | 'text/plain') => void;
  busy: string | null; onCreate: () => void; onGrant: () => void; onToggle: (rule: Rule) => void; onRequests: () => void;
}

function MocksView({ state, selected, requests, selectedId, setSelectedId, preset, setPreset, mockMode, setMockMode, keywordOne, setKeywordOne, keywordTwo, setKeywordTwo, keywordLogic, setKeywordLogic, customStatus, setCustomStatus, customBody, setCustomBody, customContentType, setCustomContentType, busy, onCreate, onGrant, onToggle, onRequests }: MocksViewProps): JSX.Element {
  const candidates = useMemo(() => findRequestCandidates(requests, [keywordOne, keywordTwo], keywordLogic), [requests, keywordOne, keywordTwo, keywordLogic]);
  return <div className="popup-view"><div className="view-title"><div><span className="popup-overline">CONTROLLED FAILURE TESTING</span><h1>Mock an API</h1></div><span className={`guard-pill ${state?.mockingAllowed ? 'safe' : ''}`}>{state?.mockingAllowed ? 'Guardrails active' : 'Blocked'}</span></div>{!state?.mockingAllowed ? <section className="override-card"><strong>Production protection is active</strong><p>{state?.mockingBlockedReason}</p><button onClick={onGrant} disabled={busy === 'override'}>{busy === 'override' ? 'Enabling…' : 'Enable this hostname for 10 minutes'}</button><small>Only exact captured URLs can be mocked. The permission expires automatically.</small></section> : null}<p className="privacy-note">Do not mock against preprod or a real submit-order journey. A fake success response can misrepresent an order. Use a dedicated local/test environment approved for mocks.</p><section className="mock-builder"><div className="builder-step"><span className="builder-label">1 · Find and select an API</span><div className="keyword-search"><input value={keywordOne} onChange={(event) => setKeywordOne(event.target.value)} placeholder="Keyword 1 · e.g. checkout" aria-label="First API search keyword" /><div className="logic-toggle" aria-label="Keyword matching logic"><button type="button" className={keywordLogic === 'and' ? 'selected' : ''} aria-pressed={keywordLogic === 'and'} onClick={() => setKeywordLogic('and')}>AND</button><button type="button" className={keywordLogic === 'or' ? 'selected' : ''} aria-pressed={keywordLogic === 'or'} onClick={() => setKeywordLogic('or')}>OR</button></div><input value={keywordTwo} onChange={(event) => setKeywordTwo(event.target.value)} placeholder="Keyword 2 · e.g. POST" aria-label="Second API search keyword" /></div><div className="api-picker" role="listbox" aria-label="Matching captured APIs"><div className="api-picker-summary"><span>{candidates.length} matching {candidates.length === 1 ? 'API' : 'APIs'}</span><small>Latest unique calls</small></div>{candidates.length ? candidates.map((request) => <button type="button" role="option" aria-selected={selectedId === request.id} className={selectedId === request.id ? 'selected' : ''} key={request.id} onClick={() => setSelectedId(request.id)}><span className={`method method-${request.method.toLowerCase()}`}>{request.method}</span><span><strong title={request.url}>{request.path}</strong><small>{request.hostname}</small></span><em>{request.statusCode ?? '…'}</em></button>) : <div className="api-picker-empty">No API matches those keywords.</div>}</div></div>{!requests.length ? <button className="text-action" onClick={onRequests}>Capture a request first →</button> : null}<div className="builder-step"><span className="builder-label">2 · Choose the response behavior</span><div className="mode-toggle"><button type="button" className={mockMode === 'preset' ? 'selected' : ''} onClick={() => setMockMode('preset')}>Quick presets</button><button type="button" className={mockMode === 'custom' ? 'selected' : ''} onClick={() => setMockMode('custom')}>Custom response</button></div>{mockMode === 'preset' ? <div className="preset-grid">{presets.map((item) => <button type="button" key={item.id} className={preset === item.id ? 'selected' : ''} onClick={() => setPreset(item.id)}><strong>{item.label}</strong><small>{item.detail}</small></button>)}</div> : <div className="custom-response"><label><span>Status</span><input inputMode="numeric" value={customStatus} onChange={(event) => setCustomStatus(event.target.value.replace(/[^0-9]/g, '').slice(0, 3))} placeholder="500" aria-label="Custom HTTP status" /></label><label><span>Content type</span><select value={customContentType} onChange={(event) => setCustomContentType(event.target.value as 'application/json' | 'text/plain')} aria-label="Custom response content type"><option value="application/json">JSON</option><option value="text/plain">Plain text</option></select></label><label className="custom-body"><span>Response body</span><textarea value={customBody} onChange={(event) => setCustomBody(event.target.value)} spellCheck={false} aria-label="Custom response body" /></label></div>}</div>{selected ? <div className="mock-target"><span>Exact-match target</span><strong>{selected.method} {selected.path}</strong><small>{selected.hostname}</small></div> : <div className="mock-target empty"><span>No target selected</span><strong>Choose one API from the results above</strong></div>}<button className="create-mock" disabled={!selected || !state?.mockingAllowed || busy === 'create-mock'} onClick={onCreate}>{busy === 'create-mock' ? 'Creating…' : `Create ${mockMode === 'custom' ? 'custom ' : ''}& enable mock`}</button></section><section className="active-rules"><div className="section-line"><strong>Rules</strong><span>{state?.rules.length ?? 0}</span></div>{state?.rules.length ? state.rules.slice().reverse().slice(0,5).map((rule) => <div className="compact-rule" key={rule.id}><button role="switch" aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`} aria-checked={rule.enabled} className={rule.enabled ? 'on' : ''} onClick={() => onToggle(rule)} disabled={busy === `rule-${rule.id}`}><span /></button><div><strong>{rule.name}</strong><small>{rule.action.statusCode ? `${rule.action.statusCode} · ` : ''}{rule.action.type} · applied {rule.appliedCount}</small></div></div>) : <p>No mock rules created yet.</p>}</section></div>;
}

interface EvidenceViewProps {
  state: PanelState | null; requests: CapturedRequest[]; failed: number; busy: string | null;
  evidenceTitle: string; setEvidenceTitle: (value: string) => void;
  scenarioTitle: string; setScenarioTitle: (value: string) => void; scenarioExpected: string; setScenarioExpected: (value: string) => void;
  screenshotLabel: string; setScreenshotLabel: (value: string) => void;
  onStart: () => void; onStop: () => void; onSaveTitle: () => void; onAddScenario: () => void;
  onScenarioStatus: (scenarioId: string, status: EvidenceScenarioStatus) => void;
  onActualResult: (scenarioId: string, value: string) => void; onScreenshot: () => void; onExport: () => void;
}

function EvidenceView({ state, requests, failed, busy, evidenceTitle, setEvidenceTitle, scenarioTitle, setScenarioTitle, scenarioExpected, setScenarioExpected, screenshotLabel, setScreenshotLabel, onStart, onStop, onSaveTitle, onAddScenario, onScenarioStatus, onActualResult, onScreenshot, onExport }: EvidenceViewProps): JSX.Element {
  const session = state?.session ?? null;
  const scenarios = session?.scenarios ?? [];
  const screenshots = screenshotCount(session);
  return <div className="popup-view evidence-workspace"><div className="view-title"><div><span className="popup-overline">CLEAR MOBILE TEST PROOF</span><h1>Evidence studio</h1></div><span className={`guard-pill ${session ? 'safe' : ''}`}>{session?.status ?? 'Not started'}</span></div><section className="evidence-subject"><label><span>Test evidence title</span><input value={evidenceTitle} onChange={(event) => setEvidenceTitle(event.target.value)} placeholder="e.g. My Plan - Account States" aria-label="Test evidence title" /></label>{session ? <button onClick={onSaveTitle} disabled={busy === 'evidence-save'}>Save title</button> : <button className="primary" onClick={onStart} disabled={!evidenceTitle.trim() || busy === 'evidence-start'}>{busy === 'evidence-start' ? 'Starting…' : 'Start evidence recording'}</button>}</section>{session ? <><div className="evidence-stats"><div><strong>{scenarios.length}</strong><span>Scenarios</span></div><div><strong>{screenshots}</strong><span>Screenshots</span></div><div><strong>{requests.length}</strong><span>Requests</span></div><div><strong className={failed ? 'danger-text' : ''}>{failed}</strong><span>Failures</span></div></div>{state?.recording ? <section className="scenario-builder"><span className="builder-label">Add scenario under this evidence</span><input value={scenarioTitle} onChange={(event) => setScenarioTitle(event.target.value)} placeholder="Scenario title" aria-label="New scenario title" /><textarea value={scenarioExpected} onChange={(event) => setScenarioExpected(event.target.value)} placeholder="Expected result" aria-label="New scenario expected result" /><button onClick={onAddScenario} disabled={!scenarioTitle.trim() || busy === 'evidence-save'}>+ Add & activate scenario</button></section> : null}<section className="scenario-list"><div className="section-line"><strong>Scenarios</strong><span>{scenarios.filter((scenario) => scenario.status === 'passed').length}/{scenarios.length} passed</span></div>{scenarios.length ? scenarios.map((scenario, index) => <article key={scenario.id} className={session.activeScenarioId === scenario.id ? 'active' : ''}><div className="scenario-heading"><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{scenario.title}</strong><small>{screenshotCount(session, scenario.id)} screenshots · {scenario.expectedResult || 'No expected result added'}</small></div><select value={scenario.status} onChange={(event) => onScenarioStatus(scenario.id, event.target.value as EvidenceScenarioStatus)} aria-label={`Status for ${scenario.title}`}><option value="not-run">Not run</option><option value="in-progress">In progress</option><option value="passed">Passed</option><option value="failed">Failed</option><option value="blocked">Blocked</option></select></div><input className="actual-result" defaultValue={scenario.actualResult} onBlur={(event) => { if (event.target.value !== scenario.actualResult) onActualResult(scenario.id, event.target.value); }} placeholder="Actual result / observation" aria-label={`Actual result for ${scenario.title}`} />{state?.recording && session.activeScenarioId !== scenario.id ? <button className="activate-scenario" onClick={() => onScenarioStatus(scenario.id, 'in-progress')}>Record this scenario</button> : session.activeScenarioId === scenario.id ? <span className="recording-chip"><i /> Evidence recording here</span> : null}</article>) : <p className="empty-copy">Add the first scenario, then reproduce it and capture screenshots at decisive states.</p>}</section>{state?.recording && session.activeScenarioId ? <section className="screenshot-capture"><div><strong>Capture visible proof</strong><small>Attached to the active scenario with URL and timestamp.</small></div><div><input value={screenshotLabel} onChange={(event) => setScreenshotLabel(event.target.value)} placeholder="Screenshot label (optional)" aria-label="Screenshot label" /><button onClick={onScreenshot} disabled={busy === 'screenshot'}>{busy === 'screenshot' ? 'Capturing…' : 'Take screenshot'}</button></div><p>Review the page first: pixels are not automatically redacted.</p></section> : null}{state?.recording ? <button className="stop-evidence" onClick={onStop} disabled={busy === 'session'}>Stop evidence recording</button> : <><section className="export-formats"><span className="builder-label">Evidence pack</span><div><span><b>HTML</b>Print-ready Clear Mobile report</span><span><b>HAR</b>Network archive</span><span><b>JSON</b>Complete data</span><span><b>MD</b>Defect summary</span></div></section><button className="export-button" disabled={busy === 'evidence'} onClick={onExport}>{busy === 'evidence' ? 'Building evidence…' : 'Export complete evidence pack'}</button></>}</> : <section className="evidence-principles"><div><b>1</b><span><strong>Name the evidence</strong><small>Use feature, journey and release context.</small></span></div><div><b>2</b><span><strong>Record per scenario</strong><small>Expected, actual and status stay together.</small></span></div><div><b>3</b><span><strong>Capture decisive states</strong><small>Label screenshots; avoid sensitive pixels.</small></span></div></section>}<p className="privacy-note">Network secrets are redacted on export. Screenshot pixels must be reviewed by the tester.</p></div>;
}

function ToolsView({ state, onRepair, onTab, busy }: { state: PanelState | null; onRepair: () => void; onTab: (tab: PopupTab) => void; busy: string | null }): JSX.Element {
  const tools = [['Network tracker','See live Fetch/XHR traffic','requests'],['Quick Mock','Simulate safe controlled failures','mocks'],['Distributed traces','Join browser and server calls','advanced'],['Evidence packs','Export HTML, HAR, JSON and Markdown','evidence'],['SDK setup','React, Next.js and Express guidance','advanced'],['Security','Built-in token and PII redaction','advanced']] as const;
  return <div className="popup-view"><div className="view-title"><div><span className="popup-overline">CAPABILITY MAP</span><h1>QA toolkit</h1></div></div><div className="tool-grid">{tools.map(([name, detail, target]) => <button key={name} onClick={() => target === 'requests' || target === 'mocks' || target === 'evidence' ? onTab(target) : undefined}><b>{name.slice(0,1)}</b><span><strong>{name}</strong><small>{detail}</small></span>{target === 'advanced' ? <em>DevTools</em> : <em>Open</em>}</button>)}</div><section className="devtools-card"><span className="popup-overline">ADVANCED WORKSPACE</span><h2>Need deep debugging?</h2><p>Press <kbd>F12</kbd> → select <strong>ApiLens</strong> for request bodies, complete traces, settings, and the feature academy.</p></section><button className="repair-wide" onClick={onRepair}>{busy === 'repair' ? 'Running Engine Doctor…' : 'Run Engine Doctor'}</button><p className="agent-line"><span className={state?.agent.state === 'connected' ? 'on' : ''} /> Local agent (optional): <strong>{state?.agent.state ?? 'checking'}</strong> · Browser capture works without it.</p></div>;
}

function Empty({ title, copy }: { title: string; copy: string }): JSX.Element { return <div className="popup-empty"><span>◎</span><strong>{title}</strong><p>{copy}</p></div>; }

const root = document.getElementById('root');
if (!root) throw new Error('ApiLens popup root element is missing.');
createRoot(root).render(<Popup />);
