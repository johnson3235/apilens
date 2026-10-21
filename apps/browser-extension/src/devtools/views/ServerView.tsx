import { useMemo, useState } from 'react';
import { VirtualTable, type VirtualTableColumn } from '../components/VirtualTable';
import { ServerCallDetail } from '../components/ServerCallDetail';
import { ServerMockEditor, describeRuleTarget } from '../components/ServerMockEditor';
import {
  SERVER_MOCK_PRESETS,
  describeStatus,
  groupCallsByRoute,
  relatedServerCalls,
  serverCallHost,
  serverRuleFromCall,
  type ServerCall,
  type ServerFlowRow,
  type ServerMockRule,
} from '../../shared/server-control';
import type { ServerData } from '../hooks/useServerData';

type Mode = 'calls' | 'mocks';
type KindFilter = 'all' | 'server' | 'client';
type StatusFilter = 'all' | 'errors' | 'mocked' | 'slow';

const SLOW_MS = 1_000;

function relative(timestamp: number | null): string {
  if (!timestamp) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/** Small payloads must not all read as "1 KB" — size is a debugging signal. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ConnectionBanner({ data, onSettings }: { data: ServerData; onSettings: () => void }): JSX.Element | null {
  const status = data.status;
  if (!status?.configured) {
    return (
      <div className="banner info">
        <div>
          <strong>No instrumented server connected.</strong>
          <span> Add the control endpoint URL and token to see server-side calls, payloads and responses.</span>
        </div>
        <button className="btn sm" onClick={onSettings}>Open settings</button>
      </div>
    );
  }
  if (data.error) {
    return (
      <div className="banner blocked" role="alert">
        <div>
          <strong>Server link problem.</strong>
          <span> {data.error}</span>
        </div>
        <button className="btn sm" onClick={onSettings}>Check settings</button>
      </div>
    );
  }
  if (status.gap) {
    return (
      <div className="banner warn">
        <div>
          <strong>Older calls were dropped.</strong>
          <span> The server buffer rolled over between polls. Increase <code>control.bufferSize</code> or poll more often.</span>
        </div>
      </div>
    );
  }
  return null;
}

function ServerHealthStrip({ data }: { data: ServerData }): JSX.Element | null {
  const health = data.status?.health;
  if (!health) return null;
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [
    { label: 'Service', ok: health.enabled, detail: health.enabled ? `${health.serviceName} · SDK ${health.sdkVersion}` : 'SDK present but disabled' },
    { label: 'Request payloads', ok: health.captureRequestBodies, detail: health.captureRequestBodies ? `Captured up to ${Math.round(health.maxBodyBytes / 1024)} KB` : 'captureBodies.request is off' },
    { label: 'Response payloads', ok: health.captureResponseBodies, detail: health.captureResponseBodies ? `Captured up to ${Math.round(health.maxBodyBytes / 1024)} KB` : 'captureBodies.response is off' },
    { label: 'Server mocking', ok: health.mockingEnabled, detail: health.mockingEnabled ? `${health.activeRuleCount} active of ${health.ruleCount}` : 'allowMockControl is false' },
    { label: 'Route mocks', ok: health.routeMocksEnabled, detail: health.routeMocksEnabled ? 'Incoming routes can be short-circuited' : 'Outbound calls only' },
  ];
  const passing = checks.filter((check) => check.ok).length;

  // Collapsed by default: a DevTools panel is short, and the call list is what
  // the tester came for. The summary still answers "is capture working?".
  return <details className="server-health-wrap">
    <summary>
      <span className={passing === checks.length ? 'ok-text' : ''}>{passing}/{checks.length} capture features enabled</span>
      <span className="muted"> · {health.serviceName} · SDK {health.sdkVersion} · synced {relative(data.status?.lastSyncAt ?? null)} · {health.bufferedCalls} buffered</span>
    </summary>
    <section className="server-health" aria-label="Server capture readiness">
      {checks.map((check) => (
        <div key={check.label} className={check.ok ? 'pass' : 'neutral'}>
          <span aria-hidden="true">{check.ok ? '✓' : '·'}</span>
          <div><strong>{check.label}</strong><small>{check.detail}</small></div>
        </div>
      ))}
      {health.droppedCalls > 0 ? (
        <div className="neutral">
          <span aria-hidden="true">!</span>
          <div><strong>Dropped</strong><small>{health.droppedCalls} calls evicted from the server buffer</small></div>
        </div>
      ) : null}
    </section>
  </details>;
}

export function ServerView({
  data,
  onSettings,
  onCopy,
  onNotice,
}: {
  data: ServerData;
  onSettings: () => void;
  onCopy: (value: string) => void;
  onNotice: (message: string) => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('calls');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [grouped, setGrouped] = useState(true);
  const [selected, setSelected] = useState<ServerCall | null>(null);
  const [draft, setDraft] = useState<ServerMockRule | null>(null);
  const [draftSample, setDraftSample] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.calls.filter((call) => {
      if (kind !== 'all' && call.kind !== kind) return false;
      if (statusFilter === 'errors' && call.status !== 'error') return false;
      if (statusFilter === 'mocked' && !call.mockedBy) return false;
      if (statusFilter === 'slow' && call.durationMs < SLOW_MS) return false;
      if (!needle) return true;
      return `${call.method} ${call.url} ${call.statusCode ?? ''} ${call.serviceName} ${call.requestBody?.content ?? ''} ${call.responseBody?.content ?? ''}`
        .toLowerCase()
        .includes(needle);
    });
  }, [data.calls, query, kind, statusFilter]);

  // Grouped: each incoming route is followed by the upstream calls it made.
  const rows = useMemo<ServerFlowRow[]>(
    () => (grouped ? groupCallsByRoute(filtered) : filtered.map((call) => ({ call, depth: 0, childCount: 0, last: false }))),
    [filtered, grouped],
  );
  const related = useMemo(() => (selected ? relatedServerCalls(selected, data.calls) : null), [selected, data.calls]);
  const multiService = useMemo(() => new Set(data.calls.map((call) => call.serviceName)).size > 1, [data.calls]);

  const stats = useMemo(() => {
    const incoming = data.calls.filter((call) => call.kind === 'server').length;
    const outgoing = data.calls.length - incoming;
    const errors = data.calls.filter((call) => call.status === 'error').length;
    const mocked = data.calls.filter((call) => call.mockedBy).length;
    const slowest = data.calls.reduce((max, call) => Math.max(max, call.durationMs), 0);
    return { incoming, outgoing, errors, mocked, slowest };
  }, [data.calls]);

  const columns: Array<VirtualTableColumn<ServerFlowRow>> = [
    {
      key: 'kind',
      header: 'Type',
      width: '78px',
      render: ({ call }) => (
        <span className={`dir ${call.kind}`} title={call.kind === 'server' ? 'The page called this server' : 'This server called a backend service'}>
          {call.kind === 'server' ? 'PAGE' : 'BACKEND'}
        </span>
      ),
    },
    { key: 'method', header: 'Method', width: '58px', className: 'mono', render: ({ call }) => <span className={`method ${call.method.toLowerCase()}`}>{call.method}</span> },
    { key: 'status', header: 'Status', width: '54px', className: 'status', render: ({ call }) => <span className={`status-pill ${call.status}`} title={describeStatus(call)}>{call.statusCode ?? (call.error ? 'ERR' : '—')}</span> },
    {
      key: 'path',
      header: 'Path',
      width: 'auto',
      className: 'mono',
      render: ({ call, depth, childCount, last }) => (
        <span className={`flow-path depth-${depth}`}>
          {depth === 1 ? <i className={`tree ${last ? 'last' : ''}`} aria-hidden="true" /> : null}
          {call.kind === 'client' ? <span className="host" title={call.origin}>{serverCallHost(call)}</span> : null}
          <span className="path-text">{call.path || call.url}</span>
          {childCount > 0 ? <span className="flow-count" title="Backend calls this server made to answer the page">{childCount} backend call{childCount === 1 ? '' : 's'}</span> : null}
        </span>
      ),
    },
    ...(multiService ? [{ key: 'service', header: 'Service', width: '108px', render: ({ call }: ServerFlowRow) => call.serviceName }] : []),
    { key: 'body', header: 'Size', width: '64px', className: 'num', render: ({ call }) => <span className="muted">{call.responseBody ? formatSize(call.responseBody.byteLength) : call.requestBody ? 'req only' : '—'}</span> },
    { key: 'mock', header: '', width: '62px', render: ({ call }) => (call.mockedBy ? <span className="badge mock" title={call.mockedBy}>mock</span> : null) },
    { key: 'duration', header: 'Time', width: '64px', className: 'num', render: ({ call }) => <span className={call.durationMs >= SLOW_MS ? 'warn-text' : ''}>{Math.round(call.durationMs)} ms</span> },
  ];

  async function persist(rules: ServerMockRule[], message: string): Promise<void> {
    setSaving(true);
    try {
      await data.saveRules(rules);
      onNotice(message);
      setDraft(null);
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  function startMockFromCall(call: ServerCall): void {
    setDraft(serverRuleFromCall(call));
    setDraftSample(call.responseBody?.encoding === 'utf8' ? call.responseBody.content : null);
    setMode('mocks');
  }

  const activeRules = data.rules.filter((rule) => rule.enabled);

  const editing = draft;
  const mockingBlocked = data.status?.health && !data.status.health.mockingEnabled;

  return (
    <div className="content server-view">
      <div className="view-header">
        <div>
          <span className="overline">SERVER-SIDE VISIBILITY</span>
          <h1>Server API calls</h1>
          <p>What the app’s server asks its backend services while you use a page, what they answer, and a safe way to make them fail on purpose.</p>
        </div>
        <div className="view-actions">
          <span className={`link-pill ${data.status?.connected ? 'on' : data.status?.configured ? 'warn' : ''}`}>
            <i aria-hidden="true" />
            {data.status?.connected ? `Connected · ${data.status.health?.serviceName ?? 'server'}` : data.status?.configured ? 'Reconnecting…' : 'Not connected'}
          </span>
          <button className="btn" onClick={() => void data.refresh()} disabled={data.syncing}>{data.syncing ? 'Syncing…' : 'Refresh'}</button>
          <button className="btn danger" onClick={() => void data.clear()}>Clear</button>
        </div>
      </div>

      <ConnectionBanner data={data} onSettings={onSettings} />

      <div className="segmented" role="tablist" aria-label="Server workspace">
        <button role="tab" aria-selected={mode === 'calls'} className={mode === 'calls' ? 'active' : ''} onClick={() => setMode('calls')}>
          Calls <b>{data.calls.length}</b>
        </button>
        <button role="tab" aria-selected={mode === 'mocks'} className={mode === 'mocks' ? 'active' : ''} onClick={() => setMode('mocks')}>
          Server mocks <b>{data.rules.length}</b>
        </button>
      </div>

      {mode === 'calls' ? (
        <>
          <ServerHealthStrip data={data} />

          <ol className="qa-steps" aria-label="How to test server calls">
            <li><b>1</b><span><strong>Use the page</strong> in the app, for example open the billing page.</span></li>
            <li><b>2</b><span><strong>Click a call</strong> to see what was sent and what came back.</span></li>
            <li><b>3</b><span><strong>Simulate a problem</strong> on a backend call, repeat the step, and check the page copes.</span></li>
          </ol>

          <div className="metric-row">
            <div><span>Page calls</span><strong>{stats.incoming}</strong></div>
            <div><span>Backend calls</span><strong>{stats.outgoing}</strong></div>
            <div><span>Failures</span><strong className={stats.errors ? 'error-text' : ''}>{stats.errors}</strong></div>
            <div><span>Mocked</span><strong className="mock-text">{stats.mocked}</strong></div>
            <div><span>Slowest</span><strong>{Math.round(stats.slowest)} ms</strong></div>
          </div>

          <div className="filter-bar">
            <label className="search-field grow">
              <span className="sr-only">Filter server calls</span>
              <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by path, status, service or payload text…" />
            </label>
            <div className="segmented sm" role="group" aria-label="Direction filter">
              {(['all', 'server', 'client'] as KindFilter[]).map((value) => (
                <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>
                  {value === 'all' ? 'All' : value === 'server' ? 'Page calls' : 'Backend calls'}
                </button>
              ))}
            </div>
            <label className="toggle-inline" title="Show each page call with the backend calls it caused">
              <input type="checkbox" checked={grouped} onChange={(event) => setGrouped(event.target.checked)} />
              Group by page call
            </label>
            <div className="segmented sm" role="group" aria-label="Status filter">
              {(['all', 'errors', 'mocked', 'slow'] as StatusFilter[]).map((value) => (
                <button key={value} className={statusFilter === value ? 'active' : ''} onClick={() => setStatusFilter(value)}>
                  {value === 'all' ? 'Any result' : value === 'slow' ? 'Slow' : value === 'errors' ? 'Failed' : 'Mocked'}
                </button>
              ))}
            </div>
          </div>

          <div className="split request-area">
            <div className="left">
              <VirtualTable
                items={rows}
                columns={columns}
                selectedId={selected?.spanId}
                onSelect={(row) => setSelected(row.call)}
                getId={(row) => row.call.spanId}
                getRowClass={({ call, depth }) => `${call.status === 'error' ? 'failed' : ''} ${call.mockedBy ? 'mocked' : ''} ${depth ? 'child' : call.kind === 'server' ? 'route' : ''}`}
                emptyTitle={data.status?.connected ? 'No server calls captured yet' : 'Waiting for a server connection'}
                emptyHint={
                  data.status?.connected
                    ? 'Use the page in the app. Its server calls appear here within a couple of seconds.'
                    : 'Open Settings → Instrumented server, paste the app address and the access token from your team lead, then use the application.'
                }
              />
            </div>
            {selected ? (
              <ServerCallDetail
                call={selected}
                related={related}
                onSelectRelated={setSelected}
                onClose={() => setSelected(null)}
                onMock={startMockFromCall}
                onCopy={(value) => {
                  onCopy(value);
                  onNotice('Copied to clipboard.');
                }}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="scroll view-page">
          {mockingBlocked ? (
            <div className="banner blocked">Server mock control is disabled for this deployment (<code>allowMockControl: false</code>).</div>
          ) : null}

          {editing ? (
            <ServerMockEditor
              rule={editing}
              saving={saving}
              sampleBody={draftSample}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSave={(enable) => {
                const others = data.rules.filter((rule) => rule.id !== editing.id);
                const saved = { ...editing, enabled: enable, updatedAt: Date.now() };
                void persist(
                  [...others, saved],
                  enable ? `“${saved.name}” is on. Repeat the step in the app now.` : `“${saved.name}” saved and kept off.`,
                );
              }}
              onDelete={
                data.rules.some((rule) => rule.id === editing.id)
                  ? () => void persist(data.rules.filter((rule) => rule.id !== editing.id), `“${editing.name}” removed.`)
                  : undefined
              }
            />
          ) : (
            <>
              <div className="row spread">
                <p className="muted">
                  A server mock makes a backend service answer the way you choose, so you can check how the page handles problems. It runs on the shared server: turn it off when you finish.
                </p>
                <div className="row">
                  {activeRules.length ? (
                    <button
                      className="btn danger"
                      disabled={saving}
                      onClick={() => void persist(data.rules.map((rule) => ({ ...rule, enabled: false, updatedAt: Date.now() })), 'All server mocks are off.')}
                    >
                      Turn all off ({activeRules.length})
                    </button>
                  ) : null}
                  <button className="btn" onClick={() => setDraft(blankRule(data.status?.health?.serviceName ?? 'server'))}>
                    New mock (advanced)
                  </button>
                </div>
              </div>

              <div className="rule-list">
                {data.rules.length === 0 ? (
                  <div className="empty-state">
                    <span aria-hidden="true">◎</span>
                    <h2>No server mocks yet</h2>
                    <p>Open the Calls tab, click a backend call, then choose “Simulate a problem”. Starting from a real call keeps the mock narrow and safe.</p>
                    <button className="btn primary" onClick={() => setMode('calls')}>Browse captured calls</button>
                  </div>
                ) : (
                  data.rules.map((rule) => (
                    <article className={`rule-card ${rule.enabled ? '' : 'off'}`} key={rule.id}>
                      <button
                        className={`switch ${rule.enabled ? 'on' : ''}`}
                        role="switch"
                        aria-checked={rule.enabled}
                        aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                        disabled={saving}
                        onClick={() =>
                          void persist(
                            data.rules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item)),
                            `${rule.name} ${rule.enabled ? 'disabled' : 'enabled'}.`,
                          )
                        }
                      >
                        <span />
                      </button>
                      <div className="rule-main">
                        <div>
                          <strong>{rule.name}</strong>
                          <span className={`badge ${rule.enabled ? 'mock' : ''}`}>{rule.enabled ? 'On' : 'Off'}</span>
                          <span className="badge">{rule.applyMode === 'once' ? 'next call only' : rule.applyMode === 'always' ? 'every call' : rule.applyMode}</span>
                        </div>
                        <p>{ruleSentence(rule)}</p>
                        <code>{rule.match.urlPattern}</code>
                      </div>
                      <div className="rule-count">Used<strong>{rule.appliedCount}</strong></div>
                      <button className="btn sm" onClick={() => setDraft(rule)}>Edit</button>
                    </article>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "When the server makes the backend call GET /billing, it gets: Service is down." */
function ruleSentence(rule: ServerMockRule): string {
  const preset = SERVER_MOCK_PRESETS.find((candidate) => JSON.stringify(candidate.apply(rule).action) === JSON.stringify(rule.action));
  const outcome = preset ? preset.title : rule.action.type === 'custom-body' ? 'your own answer' : rule.action.type;
  const spent = rule.applyMode === 'once' && rule.appliedCount >= 1 ? ' Already used once — it will not fire again.' : '';
  return `When the server makes ${describeRuleTarget(rule)}, it gets: ${outcome}.${spent}`;
}

function blankRule(serviceName: string): ServerMockRule {
  const now = Date.now();
  return {
    id: `srv-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'New server rule',
    description: `Manually created for ${serviceName}.`,
    enabled: false,
    priority: 100,
    match: { method: 'ANY', urlPattern: '', matchType: 'glob', kind: 'client' },
    action: { type: 'status-code', statusCode: 503, body: JSON.stringify({ error: 'Service unavailable', simulated: true }, null, 2) },
    applyMode: 'always',
    appliedCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}
