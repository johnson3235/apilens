import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CapturedRequest, Rule } from '@apilens/shared-types';
import { usePanelData } from './hooks/usePanelData';
import { copyToClipboard, downloadFile, inspectedTabId, send } from './hooks/bridge';
import { VirtualTable, type VirtualTableColumn } from './components/VirtualTable';
import { ChannelBadge, MethodLabel, StatusBadge } from './components/Badges';

import { CapturedHeaders } from '../shared/CapturedHeaders';

import { ServerTraceDetails } from './components/ServerTraceDetails';

type View = 'guide' | 'setup' | 'network' | 'traces' | 'mocks' | 'evidence' | 'academy' | 'settings';
const views: Array<{ id: View; label: string; hint: string }> = [
  { id: 'guide', label: 'Start here', hint: 'Guided QA workflow' },
  { id: 'setup', label: 'Integration setup', hint: 'React & server SDK' },
  { id: 'network', label: 'Network', hint: 'Captured requests' },
  { id: 'traces', label: 'Traces', hint: 'End-to-end journeys' },
  { id: 'mocks', label: 'QA Mocks', hint: 'Failure simulation' },
  { id: 'evidence', label: 'Evidence', hint: 'Export proof' },
  { id: 'academy', label: 'Feature academy', hint: 'All tools & how-to' },
  { id: 'settings', label: 'Settings', hint: 'Safety and capture' },
];

function duration(request: CapturedRequest): string {
  return request.timing.durationMs === null ? '—' : `${Math.round(request.timing.durationMs)} ms`;
}

function Panel(): JSX.Element {
  const data = usePanelData();
  const [view, setView] = useState<View>(() => localStorage.getItem('apilens.onboarded') ? 'network' : 'guide');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CapturedRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const theme = data.state?.settings.theme ?? 'dark';
    const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
    document.documentElement.dataset.theme = resolved;
  }, [data.state?.settings.theme]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? data.requests.filter((request) => `${request.method} ${request.url} ${request.statusCode ?? ''}`.toLowerCase().includes(needle)) : data.requests;
  }, [data.requests, query]);
  const failed = data.requests.filter((request) => request.error || (request.statusCode ?? 0) >= 400).length;
  const mocked = data.requests.filter((request) => request.mock).length;
  const columns: Array<VirtualTableColumn<CapturedRequest>> = [
    { key: 'method', header: 'Method', width: '68px', className: 'mono', render: (request) => <MethodLabel method={request.method} /> },
    { key: 'status', header: 'Status', width: '76px', className: 'status', render: (request) => <StatusBadge request={request} /> },
    { key: 'url', header: 'Request URL', width: '48%', className: 'mono', render: (request) => request.url },
    { key: 'channel', header: 'Source', width: '105px', render: (request) => <ChannelBadge channel={request.channel} /> },
    { key: 'duration', header: 'Duration', width: '84px', className: 'num', render: duration },
  ];

  async function runAction(name: string, task: () => Promise<void>, success: string): Promise<void> {
    setBusy(name); setNotice(null);
    try { await task(); setNotice(success); await data.refresh(); }
    catch (caught) { setNotice(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(null); }
  }

  function finishOnboarding(): void {
    localStorage.setItem('apilens.onboarded', 'true');
    setView('network');
    setNotice('You are ready. Reload the inspected page, then follow the journey you want to test.');
  }

  async function toggleRecording(): Promise<void> {
    if (data.state?.recording) {
      await runAction('record', async () => { await send({ type: 'session:stop' }); }, 'Recording stopped. Your evidence is ready to review.');
    } else {
      const name = `VOIS IE QA — ${new Date().toLocaleString()}`;
      await runAction('record', async () => { await send({ type: 'session:start', name, tabId: inspectedTabId() }); }, 'Recording started. Perform the customer journey now.');
    }
  }

  async function exportEvidence(): Promise<void> {
    if (!data.state?.session) return;
    await runAction('export', async () => {
      const response = await send<{ ok: true; files: Array<{ format: string; name: string; content: string }> }>({ type: 'evidence:export', sessionId: data.state!.session!.id, options: { formats: ['html', 'json', 'har', 'markdown'] } });
      response.files.forEach((file) => downloadFile(file.name, file.format === 'json' ? 'application/json' : 'text/plain', file.content));
    }, 'Evidence pack exported.');
  }

  async function toggleRule(rule: Rule): Promise<void> {
    const rules = data.state?.rules.map((item) => item.id === rule.id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item) ?? [];
    await runAction(`rule-${rule.id}`, async () => { await send({ type: 'rules:set', rules, tabId: inspectedTabId() }); }, `${rule.name} ${rule.enabled ? 'disabled' : 'enabled'}.`);
  }

  return <main className="app qa-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <header className="product-header">
      <div className="product-identity"><span className="brand-mark" aria-hidden="true">A</span><div><strong>ApiLens</strong><span>VOIS IE · Quality Engineering</span></div></div>
      <div className="header-status" aria-live="polite"><span className={`health-dot ${data.state?.engine?.ready ? 'ready' : ''}`} aria-hidden="true" /><span>{data.state?.engine?.ready ? 'Engine ready' : 'Engine needs attention'}</span><span className="environment-chip">{data.state?.environmentName ?? 'Local environment'}</span></div>
      <button className={`record-button ${data.state?.recording ? 'recording' : ''}`} onClick={() => void toggleRecording()} disabled={busy === 'record'} aria-pressed={data.state?.recording}><span className="record-dot" aria-hidden="true" />{data.state?.recording ? 'Stop recording' : 'Start QA session'}</button>
    </header>
    <div className="workspace">
      <nav className="side-nav" aria-label="ApiLens features"><div className="nav-label">Workspace</div>{views.map((item) => <button key={item.id} className="nav-item" aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><span>{item.label}</span><small>{item.hint}</small>{item.id === 'network' && data.requests.length ? <b>{data.requests.length}</b> : null}</button>)}<div className="nav-support"><strong>Need help?</strong><span>Open “Start here” for the safe QA workflow and feature guide.</span><button className="btn sm" onClick={() => setView('guide')}>Open guide</button></div></nav>
      <section id="main-content" className="main-stage" tabIndex={-1}>
        {notice ? <div className="toast" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div> : null}
        {data.error ? <div className="banner blocked" role="alert">{data.error}</div> : null}
        {view === 'guide' ? <Guide state={data.state} requestCount={data.requests.length} onFinish={finishOnboarding} onView={setView} onRecord={() => void toggleRecording()} onRepair={() => void runAction('repair', async () => { await send({ type: 'engine:repair', tabId: inspectedTabId() }); }, 'Page hooks repaired.')} /> : null}
        {view === 'setup' ? <IntegrationSetup state={data.state} onView={setView} onNotice={setNotice} /> : null}
        {view === 'network' ? <div className="content"><ViewHeader overline="LIVE CAPTURE" title="Network requests"><label className="search-field"><span className="sr-only">Filter requests</span><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter URL, method or status…" /></label><button className="btn" onClick={() => void data.refresh()}>Refresh</button><button className="btn danger" onClick={() => void data.clear()}>Clear</button></ViewHeader><div className="metric-row"><Metric label="Requests" value={data.requests.length} /><Metric label="Failed" value={failed} tone={failed ? 'error-text' : ''} /><Metric label="Mocked" value={mocked} tone="mock-text" /><Metric label="Traces" value={data.traces.length} /></div><div className="split request-area"><div className="left"><VirtualTable items={filtered} columns={columns} selectedId={selected?.id} onSelect={setSelected} getId={(request) => request.id} getRowClass={(request) => request.error || (request.statusCode ?? 0) >= 400 ? 'failed' : ''} emptyTitle="No API traffic yet" emptyHint="Start a QA session, reload the inspected page, then perform the customer journey." /></div>{selected ? <RequestPreview request={selected} onClose={() => setSelected(null)} onMock={() => setView('mocks')} /> : null}</div></div> : null}
        {view === 'traces' ? <div className="scroll view-page"><ViewHeader overline="CORRELATION" title="Distributed traces" description="Browser, SDK and proxy spans grouped into customer journeys." />{data.traces.length ? <div className="trace-cards">{data.traces.map((trace, index) => <article className="trace-card" key={trace.traceId}><span className="badge accent">Trace {index + 1}</span><strong className="mono">{trace.traceId}</strong><p>{trace.spanCount} correlated span(s)</p><ServerTraceDetails trace={trace} /></article>)}</div> : <EmptyState title="No traces captured" copy="Enable trace headers for a controlled environment, start a session, and complete a journey." action="Open settings" onAction={() => setView('settings')} />}</div> : null}
        {view === 'mocks' ? <div className="scroll view-page"><ViewHeader overline="CONTROLLED FAILURE TESTING" title="QA Mocks" description="Simulate errors only in approved environments. Rules are applied in priority order."><button className="btn primary" onClick={() => void runAction('repair', async () => { await send({ type: 'engine:repair', tabId: inspectedTabId() }); }, 'Repair completed and the Fetch/XHR self-test ran successfully.')}>Repair & test</button></ViewHeader><EngineDoctor state={data.state} onGuide={() => setView('academy')} />{data.state?.mockingBlockedReason ? <div className="banner blocked">Mocking blocked: {data.state.mockingBlockedReason}</div> : null}<div className="rule-list">{data.state?.rules.length ? data.state.rules.map((rule) => <RuleCard key={rule.id} rule={rule} busy={busy === `rule-${rule.id}`} onToggle={() => void toggleRule(rule)} />) : <EmptyState title="No mock rules yet" copy="Capture the exact request in Network, select it, and choose Create mock. This prevents accidental broad rules." action="Capture requests" onAction={() => setView('network')} />}</div></div> : null}
        {view === 'evidence' ? <div className="scroll view-page"><ViewHeader overline="DEFECT & SIGN-OFF PROOF" title="Evidence pack" description="Export the current QA session in formats suited to engineers, audit and defect management." /><div className="evidence-layout"><div className="panelbox"><h2>{data.state?.session?.name ?? 'No active session'}</h2><dl className="evidence-summary"><div><dt>Requests</dt><dd>{data.requests.length}</dd></div><div><dt>Failures</dt><dd>{failed}</dd></div><div><dt>Mocked</dt><dd>{mocked}</dd></div><div><dt>Markers</dt><dd>{data.state?.session?.markers.length ?? 0}</dd></div></dl><button className="btn primary large" disabled={!data.state?.session || busy === 'export'} onClick={() => void exportEvidence()}>Export complete evidence pack</button><p className="muted">Includes HTML report, HAR, JSON and Markdown.</p></div><div className="export-guide"><h3>Before exporting</h3><ol><li>Finish the complete customer journey.</li><li>Stop recording so timings are final.</li><li>Review failed and mocked requests.</li><li>Add the exported pack to the defect or test evidence.</li></ol></div></div></div> : null}
        {view === 'academy' ? <FeatureAcademy onView={setView} /> : null}
        {view === 'settings' && data.state ? <Settings state={data.state} runAction={runAction} /> : null}
      </section>
    </div>
  </main>;
}

function Guide({ state, requestCount, onFinish, onView, onRecord, onRepair }: { state: ReturnType<typeof usePanelData>['state']; requestCount: number; onFinish: () => void; onView: (view: View) => void; onRecord: () => void; onRepair: () => void }): JSX.Element {
  const features: Array<[string, string, View]> = [['Integration setup','Configure React, Next.js or Express correctly','setup'],['Network','Inspect headers, payloads, timings and errors','network'],['Distributed traces','Follow browser and server spans end to end','traces'],['QA Mocks','Simulate 4xx, 5xx, latency, timeout and payload defects','mocks'],['Replay','Re-run a captured request safely from its detail view','network'],['Contract checks','Validate responses and assertions against expectations','network'],['Evidence packs','Export audit-ready proof for defects and sign-off','evidence'],['Security redaction','Protect tokens, personal data and sensitive headers','settings'],['Local agent','Join server-side calls and proxy traffic','settings']];
  return <div className="scroll guide-page"><div className="hero-card"><div className="hero-copy"><span className="overline">FIRST-USE GUIDE · VOIS IE MARKET</span><h1>Test customer journeys with confidence</h1><p>Capture the real request, simulate the failure, verify recovery, and export evidence—without changing production data.</p><div className="row"><button className="btn primary large" onClick={onFinish}>Start guided testing</button><button className="btn large" onClick={() => onView('network')}>Explore workspace</button></div></div><div className="hero-score"><strong>{state?.engine?.ready ? 'Ready' : '1 action'}</strong><span>{state?.engine?.ready ? 'Page hooks connected' : 'Repair the page hooks'}</span></div></div><section className="guide-section"><div className="section-heading"><div><span className="overline">RECOMMENDED WORKFLOW</span><h2>Your QA journey in four steps</h2></div><span className="keyboard-note">Keyboard accessible · <kbd>Tab</kbd> to navigate</span></div><ol className="workflow-grid"><Workflow number="01" title="Prepare" copy="Open the IE market page and confirm the engine status is green." action={state?.engine?.ready ? 'Ready' : 'Repair engine'} onAction={onRepair} done={state?.engine?.ready} /><Workflow number="02" title="Record" copy="Start a named session before reproducing the customer journey." action={state?.recording ? 'Stop recording' : 'Start session'} onAction={onRecord} /><Workflow number="03" title="Test failures" copy="Capture an API, then enable a controlled QA mock for that endpoint." action={requestCount ? 'Open QA Mocks' : 'Capture a request'} onAction={() => onView(requestCount ? 'mocks' : 'network')} /><Workflow number="04" title="Prove" copy="Review traces and export HTML, HAR, JSON, and Markdown evidence." action="Review evidence" onAction={() => onView('evidence')} /></ol></section><section className="guide-section"><div className="section-heading"><div><span className="overline">FEATURE ACCESS</span><h2>Everything a QA engineer needs</h2></div></div><div className="feature-grid">{features.map(([title, copy, target]) => <button className="feature-card" key={title} onClick={() => onView(target)}><span className="feature-icon" aria-hidden="true">{title.slice(0,1)}</span><strong>{title}</strong><p>{copy}</p><em>Open feature →</em></button>)}</div></section><section className="safety-callout"><strong>VOIS IE safety guardrails</strong><p>Mocks are limited by environment policy. Sensitive headers and payload fields are redacted before storage. Keep Node SDK integration disabled unless the controlled backend is prepared for QA headers.</p></section></div>;
}

type SetupTarget = 'react' | 'next' | 'express';
const setupSnippets: Record<SetupTarget, string> = {
  react: `// React SPA: no ApiLens package or provider is required.
// Existing fetch and XMLHttpRequest calls are captured automatically.
const response = await fetch('/api/customer', {
  headers: { Accept: 'application/json' },
});
const customer = await response.json();`,
  next: `// Node runtime only: @apilens/next-sdk 0.1.0
// Build/pack sdks/next; install the local .tgz, not workspace:*.
// lib/apilens.server.ts (server-only singleton)
import { ApiLensNextSDK } from '@apilens/next-sdk';
export const sdk = new ApiLensNextSDK({
  serviceName: 'clear-app-bff',
  enabled: process.env.APILENS_ENABLED === 'true',
  agentToken: process.env.APILENS_AGENT_TOKEN,
  allowedAppOrigins: ['http://localhost:3000'],
});
// instrumentation.ts register(): sdk.installFetch() in Node runtime.
// Every app/api/.../route.ts must wrap its supported handler:
// export const runtime = 'nodejs';
// export const GET = sdk.wrapRoute(existingHandler);
// Agent + matching token + opt-in trace headers + QA session required.
// Not Edge middleware, Server Actions, DB calls or downstream internals.`,
  express: `import express from 'express';
import { ApiLensSDK } from '@apilens/node-sdk';

const app = express();
const apilens = new ApiLensSDK({
  serviceName: 'vois-ie-api',
  reporterUrl: process.env.APILENS_REPORTER_URL,
  enabled: process.env.APILENS_ENABLED === 'true',
});

app.use(express.json());
app.use(apilens.expressMiddleware()); // before application routes
app.use('/api', apiRoutes);

process.on('SIGTERM', () => apilens.shutdown());`,
};

function IntegrationSetup({ state, onView, onNotice }: { state: ReturnType<typeof usePanelData>['state']; onView: (view: View) => void; onNotice: (notice: string) => void }): JSX.Element {
  const [target, setTarget] = useState<SetupTarget>('react');
  const supportedPage = Boolean(state?.pageUrl?.startsWith('http'));
  const engineReady = state?.engine?.ready === true;
  const agentReady = state?.agent.state === 'connected';
  const details = {
    react: { label: 'React SPA', eyebrow: 'ZERO APP CHANGES', title: 'Browser capture is already integrated', copy: 'ApiLens observes Fetch and XHR from the inspected React page. Do not install the Node SDK in client components.', steps: ['Load the unpacked extension and open the React application.', 'Open DevTools → ApiLens, then reload the inspected page once.', 'Start a QA session and perform the customer journey.', 'Use Engine Doctor before enabling a controlled mock.'] },
    next: { label: 'Next.js SSR / BFF', eyebrow: 'OPT-IN NODE SERVER CAPTURE', title: 'Connect App Router and server fetch', copy: 'The new @apilens/next-sdk wraps Web Request/Response handlers and instruments native fetch inside their QA context. The old Express SDK remains unsuitable for App Router.', steps: ['Install the built Next SDK tarball in the controlled server application.', 'Create a server-only singleton and wrap each App Router HTTP handler.', 'Run the local agent; configure the same token on server and extension.', 'Enable trace headers, start a QA session, reload and inspect Traces.'] },
    express: { label: 'Express API', eyebrow: 'OPTIONAL SERVER SDK', title: 'Trace the controlled backend', copy: 'Install middleware before application routes so incoming QA context and outgoing service calls stay correlated.', steps: ['Install @apilens/node-sdk in the API service.', 'Create the SDK once during process startup.', 'Register expressMiddleware before API routes.', 'Call shutdown during graceful process termination.'] },
  }[target];
  const copy = async (): Promise<void> => onNotice(await copyToClipboard(setupSnippets[target]) ? `${details.label} configuration copied.` : 'Clipboard access was blocked. Select the code and copy it manually.');
  return <div className="scroll view-page setup-page"><ViewHeader overline="REACT & SERVER INTEGRATION" title="Integration setup" description="Choose where the request originates. Browser calls need no SDK; App Router server fetch requires the new Next SDK, route wrappers and an agent." />
    <section className="setup-status" aria-label="Integration readiness"><div className={supportedPage ? 'pass' : 'fail'}><span>{supportedPage ? '✓' : '!'}</span><div><strong>Inspected web page</strong><small>{supportedPage ? 'HTTP(S) page detected' : 'Open the React application in the selected tab'}</small></div></div><div className={engineReady ? 'pass' : 'fail'}><span>{engineReady ? '✓' : '!'}</span><div><strong>Browser capture</strong><small>{engineReady ? 'Fetch and XHR hooks are ready' : 'Reload the page or run Engine Doctor'}</small></div></div><div className={agentReady ? 'pass' : 'neutral'}><span>{agentReady ? '✓' : '·'}</span><div><strong>Server connection</strong><small>{agentReady ? 'Local QA agent connected' : 'Optional; disconnected does not block browser capture'}</small></div></div></section>
    <div className="framework-tabs" role="tablist" aria-label="Choose application runtime">{(['react','next','express'] as SetupTarget[]).map((item) => <button key={item} role="tab" aria-selected={target === item} className={target === item ? 'active' : ''} onClick={() => setTarget(item)}>{item === 'react' ? 'React SPA' : item === 'next' ? 'Next.js SSR / BFF' : 'Express API'}</button>)}</div>
    <section className="setup-grid"><article className="setup-guide"><span className="overline">{details.eyebrow}</span><h2>{details.title}</h2><p>{details.copy}</p><ol>{details.steps.map((step, index) => <li key={step}><span>{index + 1}</span><div>{step}</div></li>)}</ol>{target === 'react' ? <button className="btn primary" onClick={() => onView('network')}>Start browser capture</button> : <button className="btn primary" onClick={() => onView('settings')}>Configure local agent</button>}</article><article className="code-card"><header><div><span>Configuration</span><strong>{details.label}</strong></div><button className="btn sm" onClick={() => void copy()}>Copy code</button></header><pre tabIndex={0}><code>{setupSnippets[target]}</code></pre></article></section>
    <aside className="setup-safety"><strong>Safe-by-default setup</strong><p>Keep <code>APILENS_ENABLED</code> false outside approved QA environments. Never expose the Node SDK in a browser bundle or manually add QA trace headers to production requests.</p></aside>
  </div>;
}

function Workflow({ number, title, copy, action, onAction, done }: { number: string; title: string; copy: string; action: string; onAction: () => void; done?: boolean }): JSX.Element { return <li><span>{number}</span><div><strong>{title}</strong><p>{copy}</p>{done ? <em>✓ Ready</em> : <button className="btn sm" onClick={onAction}>{action}</button>}</div></li>; }
function ViewHeader({ overline, title, description, children }: { overline: string; title: string; description?: string; children?: React.ReactNode }): JSX.Element { return <div className="view-header"><div><span className="overline">{overline}</span><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{children ? <div className="view-actions">{children}</div> : null}</div>; }
function Metric({ label, value, tone = '' }: { label: string; value: number; tone?: string }): JSX.Element { return <div><span>{label}</span><strong className={tone}>{value}</strong></div>; }
function RequestPreview({ request, onClose, onMock }: { request: CapturedRequest; onClose: () => void; onMock: () => void }): JSX.Element { return <aside className="right request-preview" aria-label="Selected request details"><div className="preview-head"><div><MethodLabel method={request.method} /> <strong>{request.path}</strong></div><button className="btn sm" onClick={onClose}>Close</button></div><div className="scroll pad"><div className="eyebrow">Request URL</div><div className="mono wrap">{request.url}</div><div className="preview-grid"><div><span>Status</span><strong>{request.statusCode ?? 'Pending'}</strong></div><div><span>Duration</span><strong>{duration(request)}</strong></div><div><span>Source</span><ChannelBadge channel={request.channel} /></div><div><span>Mocked</span><strong>{request.mock ? 'Yes' : 'No'}</strong></div></div>{request.error ? <div className="error-card">{request.error}</div> : null}<CapturedHeaders requestHeaders={request.requestHeaders} responseHeaders={request.responseHeaders} /><div className="detail-actions"><button className="btn primary" onClick={onMock}>Create mock</button><button className="btn" disabled title="Available after configuring replay target">Replay request</button></div></div></aside>; }
function RuleCard({ rule, busy, onToggle }: { rule: Rule; busy: boolean; onToggle: () => void }): JSX.Element { return <article className="rule-card"><button className={`switch ${rule.enabled ? 'on' : ''}`} role="switch" aria-checked={rule.enabled} aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`} onClick={onToggle} disabled={busy}><span /></button><div className="rule-main"><div><strong>{rule.name}</strong><span className="badge mock">{rule.action.type}</span></div><p>{rule.description || `${rule.conditions.length} match condition(s)`}</p><code>{rule.conditions.map((condition) => `${condition.field} ${condition.operator} ${condition.value}`).join(' · ')}</code></div><div className="rule-count">Applied<strong>{rule.appliedCount}</strong></div></article>; }
function EmptyState({ title, copy, action, onAction }: { title: string; copy: string; action: string; onAction: () => void }): JSX.Element { return <div className="empty-state"><span aria-hidden="true">◎</span><h2>{title}</h2><p>{copy}</p><button className="btn primary" onClick={onAction}>{action}</button></div>; }
function SettingToggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element { return <label className="setting-toggle"><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>; }

function EngineDoctor({ state, onGuide }: { state: ReturnType<typeof usePanelData>['state']; onGuide: () => void }): JSX.Element {
  const engine = state?.engine;
  const checks = [
    { label: 'Supported page', ok: Boolean(state?.pageUrl?.startsWith('http')), detail: state?.pageUrl ?? 'No inspected page detected' },
    { label: 'Environment policy', ok: state?.mockingAllowed === true, detail: state?.mockingAllowed ? (state.environmentName ?? 'Allowed') : (state?.mockingBlockedReason ?? 'Not allowed') },
    { label: 'Page hooks', ok: engine?.hooksInstalled === true, detail: engine?.hooksInstalled ? 'Fetch and XHR installed' : 'Hooks missing or replaced' },
    { label: 'Rules synchronized', ok: engine?.rulesSynced === true, detail: `${engine?.enabledRuleCount ?? 0} enabled rule(s)` },
    { label: 'Self-test', ok: engine?.lastSelfTest?.ok === true, detail: engine?.lastSelfTest ? (engine.lastSelfTest.ok ? 'Synthetic Fetch/XHR test passed' : engine.lastSelfTest.error ?? 'Test failed') : 'Run Repair & test' },
  ];
  return <section className={`engine-doctor ${engine?.ready && engine.lastSelfTest?.ok ? 'healthy' : ''}`} aria-labelledby="engine-doctor-title"><div className="doctor-heading"><div><span className="overline">ENGINE DOCTOR</span><h2 id="engine-doctor-title">{engine?.ready && engine.lastSelfTest?.ok ? 'Mock engine verified' : 'Mock engine needs attention'}</h2><p>{engine?.error ?? 'Five checks prove that mocks can reach the inspected page.'}</p></div><span className={`doctor-score ${checks.every((check) => check.ok) ? 'ok' : ''}`}>{checks.filter((check) => check.ok).length}/5</span></div><div className="doctor-checks">{checks.map((check) => <div key={check.label} className={check.ok ? 'pass' : 'fail'}><span aria-hidden="true">{check.ok ? '✓' : '!'}</span><div><strong>{check.label}</strong><small>{check.detail}</small></div></div>)}</div><div className="doctor-help"><strong>If it still fails:</strong><span>Open a normal HTTP(S) page → reload it once → keep that tab selected → click Repair & test. Internal pages such as brave:// and extension stores cannot be injected.</span><button className="btn sm" onClick={onGuide}>Open mock guide</button></div></section>;
}

function FeatureAcademy({ onView }: { onView: (view: View) => void }): JSX.Element {
  const lessons: Array<{ title: string; value: string; steps: string[]; result: string; target: View; safety?: string }> = [
    { title: 'QA Sessions', value: 'Keep one customer journey and its evidence together.', steps: ['Open the target IE market page.', 'Click Start QA session in the header.', 'Perform one complete journey, then stop recording.'], result: 'A named session containing requests, spans, markers and active rules.', target: 'network' },
    { title: 'Network Capture', value: 'Find the exact API behind a UI action.', steps: ['Start a session and reload the page.', 'Perform the UI action.', 'Filter by path, method or status and select the request.'], result: 'Headers, payload, source, status and duration for the real call.', target: 'network' },
    { title: 'QA Mock Engine', value: 'Prove graceful handling of controlled failures.', steps: ['Run Repair & test until all five checks pass.', 'Create a rule from the captured request.', 'Enable it, repeat the UI action and inspect the Mocked badge.'], result: 'A synthetic response with X-ApiLens-Mocked evidence.', target: 'mocks', safety: 'Never use broad rules on an unapproved environment.' },
    { title: 'Failure Scenarios', value: 'Cover service, auth, network and payload resilience.', steps: ['Choose status/503, rate limit/429, timeout or connection failure.', 'Add delay or payload mutation when required.', 'Use once or n-times mode for retry testing.'], result: 'Repeatable negative tests without changing backend data.', target: 'mocks' },
    { title: 'Distributed Traces', value: 'Connect browser calls to controlled backend services.', steps: ['Use @apilens/next-sdk wrappers for Node App Router handlers, or the separate Express SDK for Express.', 'Connect the authenticated local agent and enable same-origin trace headers.', 'Start a QA session, perform a journey and expand Traces to inspect server fetch calls.'], result: 'One browser/server waterfall with service boundaries.', target: 'traces', safety: 'Keep server integration off for ordinary sites.' },
    { title: 'Replay', value: 'Re-run a captured request while investigating an issue.', steps: ['Select a completed request.', 'Review and redact headers/body.', 'Choose extension replay or connected-agent replay.'], result: 'A separate replay result without repeating the whole UI journey.', target: 'network', safety: 'Avoid replaying state-changing production requests.' },
    { title: 'Assertions & Contracts', value: 'Turn observed behavior into repeatable checks.', steps: ['Capture a representative success response.', 'Define status, timing, header or body expectations.', 'Attach an OpenAPI/contract set and review violations.'], result: 'Clear pass/fail evidence and schema drift detection.', target: 'network' },
    { title: 'API Catalog', value: 'Discover endpoints actually used by the customer journey.', steps: ['Record several journeys.', 'Group calls by method and normalized path.', 'Review observed status codes and average duration.'], result: 'A living catalog based on real test traffic.', target: 'network' },
    { title: 'Bookmarks & Markers', value: 'Highlight the calls and moments that explain a defect.', steps: ['Select the important request.', 'Bookmark it with a defect-focused note.', 'Add test-step or navigation markers during recording.'], result: 'Evidence reviewers reach the important event quickly.', target: 'evidence' },
    { title: 'Evidence Export', value: 'Create an audit-ready attachment for defect or sign-off.', steps: ['Stop the completed session.', 'Review failed and mocked calls.', 'Export HTML, HAR, JSON and Markdown.'], result: 'Human-readable and machine-readable proof from one session.', target: 'evidence' },
    { title: 'Security & Redaction', value: 'Protect credentials and personal information by default.', steps: ['Keep built-in redaction rules enabled.', 'Review captured bodies before sharing.', 'Limit retention and maximum body size.'], result: 'Local-first evidence with sensitive values removed.', target: 'settings' },
    { title: 'Accessibility Workflow', value: 'Use the extension without mouse-only dependencies.', steps: ['Use Tab and Shift+Tab through controls.', 'Use Enter/Space on rows, switches and actions.', 'Choose system theme and reduced-motion OS preference.'], result: 'Visible focus, semantic status and usable contrast.', target: 'settings' },
  ];
  return <div className="scroll view-page academy-page"><ViewHeader overline="COMPLETE PRODUCT GUIDE" title="Feature academy" description="What every tool does, how to use it, and what evidence to expect." /><div className="academy-intro"><strong>Recommended VOIS IE path</strong><span>Session → Capture → Mock → Verify recovery → Trace → Export evidence</span></div><div className="lesson-grid">{lessons.map((lesson, index) => <article className="lesson-card" key={lesson.title}><header><span>{String(index + 1).padStart(2, '0')}</span><div><h2>{lesson.title}</h2><p>{lesson.value}</p></div></header><ol>{lesson.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="expected"><strong>Expected value</strong><span>{lesson.result}</span></div>{lesson.safety ? <div className="lesson-safety"><strong>Safety</strong> {lesson.safety}</div> : null}<button className="btn" onClick={() => onView(lesson.target)}>Open {lesson.title}</button></article>)}</div></div>;
}

function Settings({ state, runAction }: { state: NonNullable<ReturnType<typeof usePanelData>['state']>; runAction: (name: string, task: () => Promise<void>, success: string) => Promise<void> }): JSX.Element {
  const save = (settings: typeof state.settings, success: string) => void runAction('settings', async () => { await send({ type: 'settings:set', settings }); }, success);
  return <div className="scroll view-page"><ViewHeader overline="PRIVACY, SAFETY & CONNECTIVITY" title="Settings" description="Defaults are designed for safe local QA use." /><div className="settings-grid"><section className="panelbox"><h2>Capture</h2><SettingToggle label="Capture response bodies" description="Required for payload checks; sensitive fields are redacted." checked={state.settings.capture.captureBodies} onChange={(checked) => save({ ...state.settings, capture: { ...state.settings.capture, captureBodies: checked } }, 'Capture settings saved.')} /><SettingToggle label="Include static assets" description="Keep off for a cleaner API-focused view." checked={state.settings.capture.captureStaticAssets} onChange={(checked) => save({ ...state.settings, capture: { ...state.settings.capture, captureStaticAssets: checked } }, 'Capture settings saved.')} /><SettingToggle label="Inject trace headers" description="Use only where the IE environment permits traceparent headers." checked={state.settings.capture.injectTraceHeaders} onChange={(checked) => save({ ...state.settings, capture: { ...state.settings.capture, injectTraceHeaders: checked } }, 'Trace settings saved.')} /></section><section className="panelbox"><h2>Local QA agent</h2><SettingToggle label="Enable agent integration" description="Joins Node SDK and proxy traffic to browser journeys." checked={state.settings.agent.enabled} onChange={(checked) => save({ ...state.settings, agent: { ...state.settings.agent, enabled: checked } }, 'Agent settings saved.')} /><AgentTokenForm state={state} runAction={runAction} /><div className="connection-row"><span>Connection</span><strong className={state.agent.state === 'connected' ? 'ok-text' : 'muted'}>{state.agent.state}</strong></div><button className="btn" onClick={() => void runAction('agent', async () => { await send({ type: state.agent.state === 'connected' ? 'agent:disconnect' : 'agent:connect' }); }, 'Agent connection updated.')}>{state.agent.state === 'connected' ? 'Disconnect agent' : 'Connect agent'}</button></section><section className="panelbox"><h2>Appearance & accessibility</h2><label className="field"><span>Theme</span><select className="select" value={state.settings.theme} onChange={(event) => save({ ...state.settings, theme: event.target.value as 'dark' | 'light' | 'system' }, 'Theme saved.')}><option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option></select></label><p className="muted">Keyboard navigation, visible focus, reduced motion, semantic landmarks and high-contrast status indicators are built in.</p></section><section className="panelbox"><h2>Data protection</h2><div className="security-stat"><strong>{state.settings.redaction.rules.filter((rule) => rule.enabled).length}</strong><span>active redaction rules</span></div><p>Authorization headers, tokens and configured personal data fields are redacted before local storage.</p></section></div></div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('ApiLens panel root element is missing.');
createRoot(root).render(<Panel />);
function AgentTokenForm({ state, runAction }: { state: import('../shared/messages').PanelState; runAction: (key: string, task: () => Promise<void>, notice: string) => Promise<void> }): JSX.Element {
  const [token, setToken] = useState(state.settings.agent.token);
  return <form onSubmit={(event) => { event.preventDefault(); void runAction('agent-token', async () => {
    await send({ type: 'settings:set', settings: { ...state.settings, agent: { ...state.settings.agent, token: token.trim(), enabled: true } } });
  }, 'Agent credentials saved; connecting.'); }}>
    <label className="field"><span>Local agent token (server-only secret)</span><input className="input" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
    <button className="btn" disabled={!token.trim()}>Save token &amp; connect</button>
  </form>;
}
