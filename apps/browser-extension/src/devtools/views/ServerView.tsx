import { useEffect, useMemo, useRef, useState } from 'react';
import { VirtualTable, type VirtualTableColumn } from '../components/VirtualTable';
import { ServerCallDetail } from '../components/ServerCallDetail';
import { ServerMockEditor } from '../components/ServerMockEditor';
import { CaptureDiagnosisCard } from '../components/CaptureDiagnosisCard';
import { Icon } from '../components/Icon';
import {
  groupCallsByRoute,
  relatedServerCalls,
  serverCallKindClass,
  serverCallKindLabel,
  serverCallLayer,
  serverCallParent,
  serverCallService,
  serverCallTmf,
  serverRuleFromCall,
  type ServerCall,
  type ServerFlowRow,
  type ServerMockRule,
} from '../../shared/server-control';
import { diagnoseCapture } from '../../shared/server-diagnosis';
import type { ServerData } from '../hooks/useServerData';

type KindFilter = 'all' | 'pages' | 'backend' | 'tmf';
type Flag = 'failed' | 'slow' | 'mocked' | 'cached';

const SLOW_MS = 1_000;

function relative(timestamp: number | null): string {
  if (!timestamp) return 'never';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

const matchesFlag = (call: ServerCall, flag: Flag): boolean =>
  flag === 'failed' ? call.status === 'error'
    : flag === 'slow' ? call.durationMs >= SLOW_MS
      : flag === 'mocked' ? Boolean(call.mockedBy)
        : call.cache === 'hit';

function statusClass(call: ServerCall): string {
  if (call.statusCode === null) return call.error ? 'err' : 'none';
  if (call.statusCode >= 400) return 'err';
  if (call.statusCode >= 300) return 'redirect';
  return 'ok';
}

function barClass(call: ServerCall, depth: number): string {
  if (call.status === 'error') return 'err';
  if (call.mockedBy) return 'mock';
  if (call.cache === 'hit') return 'cache';
  if (call.stage === 'middleware') return 'mw';
  if (depth === 0) return 'root';
  return serverCallLayer(call) === 'tmf' ? 'tmf' : 'ok';
}

/** One line per page (or per backend call with TMF calls under it): what it took to answer it. */
function pageSummary(children: ServerCall[]): string {
  const backend = children.filter((call) => serverCallLayer(call) === 'service' && call.stage !== 'middleware').length;
  // TMF APIs: called by the BFF directly, or seen by the relay further down.
  const tmf = children.filter((call) => serverCallLayer(call) === 'tmf').length;
  const cached = children.filter((call) => call.cache === 'hit').length;
  const middleware = children.some((call) => call.stage === 'middleware');
  const failed = children.filter((call) => call.status === 'error').length;
  return [
    backend ? `${backend} backend` : null,
    tmf ? `${tmf} TMF` : null,
    middleware ? 'middleware' : null,
    cached ? `${cached} cached` : null,
    failed ? `${failed} failed` : null,
  ].filter(Boolean).join(' · ');
}

const KIND_LABELS: Record<KindFilter, string> = { all: 'All', pages: 'Pages', backend: 'Backend', tmf: 'TMF' };

interface Row extends ServerFlowRow {
  /** The page's time window, for the waterfall. */
  window: { start: number; end: number };
  summary: string;
}

export function ServerView({
  data,
  sessionId = null,
  onSettings,
  onCopy,
  onNotice,
  onOpenBrowserCalls,
  onOpenMocks,
}: {
  data: ServerData;
  /** The QA session recording in this tab, whose calls "My session" shows. */
  sessionId?: string | null;
  onSettings: () => void;
  onCopy: (value: string) => void;
  onNotice: (message: string) => void;
  onOpenBrowserCalls?: () => void;
  onOpenMocks?: () => void;
}): JSX.Element {
  // On a shared server, other testers' traffic is noise; default to this tester's own calls while recording.
  const [scope, setScope] = useState<'mine' | 'everyone'>('mine');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [flags, setFlags] = useState<Set<Flag>>(new Set());
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ServerCall | null>(null);
  const [draft, setDraft] = useState<{ rule: ServerMockRule; sample: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDiagnosis, setShowDiagnosis] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const mineOnly = scope === 'mine' && sessionId !== null;
  const scoped = useMemo(() => (mineOnly ? data.calls.filter((call) => call.sessionId === sessionId) : data.calls), [data.calls, mineOnly, sessionId]);
  const hiddenByScope = data.calls.length - scoped.length;
  const diagnosis = useMemo(() => diagnoseCapture(data.status, data.calls.length), [data.status, data.calls.length]);

  // "/" jumps to the filter, Escape closes whatever is open on the right.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'Escape' && !typing) {
        if (draft) setDraft(null);
        else setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  const counts = useMemo(() => {
    const result: Record<Flag, number> = { failed: 0, slow: 0, mocked: 0, cached: 0 };
    for (const call of scoped) for (const flag of Object.keys(result) as Flag[]) if (matchesFlag(call, flag)) result[flag] += 1;
    return result;
  }, [scoped]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const direct = scoped.filter((call) => {
      if (kind === 'pages' && call.kind !== 'server') return false;
      if (kind === 'backend' && call.kind !== 'client') return false;
      if (kind === 'tmf' && serverCallLayer(call) !== 'tmf') return false;
      for (const flag of flags) if (!matchesFlag(call, flag)) return false;
      if (!needle) return true;
      const tmf = serverCallTmf(call);
      return `${call.method} ${call.url} ${call.statusCode ?? ''} ${call.serviceName} ${call.layer ?? ''} ${tmf ? `${tmf.id} ${tmf.name ?? ''}` : ''} ${call.mockedBy ?? ''} ${call.requestBody?.content ?? ''} ${call.responseBody?.content ?? ''}`
        .toLowerCase()
        .includes(needle);
    });
    if (!grouped || kind !== 'all' || (flags.size === 0 && !needle)) return direct;
    // A matching call keeps everything above it (page, middleware run, the backend call a TMF call came from), so it is never shown out of context.
    const keep = new Set(direct.map((call) => call.spanId));
    for (const call of direct) {
      let parent = serverCallParent(call, scoped);
      for (let hops = 0; parent && hops < 8; hops += 1) {
        keep.add(parent.spanId);
        if (parent.stage === 'middleware') {
          const run = parent;
          const page = scoped.find((candidate) => candidate.middlewareSpanId === run.spanId);
          if (page) keep.add(page.spanId);
        }
        parent = serverCallParent(parent, scoped);
      }
    }
    return scoped.filter((call) => keep.has(call.spanId));
  }, [scoped, query, kind, flags, grouped]);

  const rows = useMemo<Row[]>(() => {
    const flow: ServerFlowRow[] = grouped ? groupCallsByRoute(filtered) : filtered.map((call) => ({ call, depth: 0, childCount: 0, last: false }));
    // Everything a row caused: the rows after it that sit deeper, up to its next sibling.
    const subtreeEnd = (at: number): number => {
      let end = at + 1;
      while (end < flow.length && flow[end]!.depth > flow[at]!.depth) end += 1;
      return end;
    };
    const result: Row[] = [];
    let index = 0;
    while (index < flow.length) {
      const head = flow[index]!;
      const end = subtreeEnd(index);
      const members = flow.slice(index, end).map((row) => row.call);
      const window = {
        start: Math.min(...members.map((call) => call.startedAt)),
        end: Math.max(...members.map((call) => call.endedAt), head.call.startedAt + 1),
      };
      // Any row can be folded: a page, or a JCS call with the TMF calls under it.
      let hideDeeperThan = Number.POSITIVE_INFINITY;
      for (let at = index; at < end; at += 1) {
        const row = flow[at]!;
        if (row.depth > hideDeeperThan) continue;
        hideDeeperThan = Number.POSITIVE_INFINITY;
        const below = subtreeEnd(at);
        const summary = below - at > 1 ? pageSummary(flow.slice(at + 1, below).map((child) => child.call)) : '';
        result.push({ ...row, window, summary });
        if (collapsed.has(row.call.spanId)) hideDeeperThan = row.depth;
      }
      index = end;
    }
    return result;
  }, [filtered, grouped, collapsed]);

  const related = useMemo(() => (selected ? relatedServerCalls(selected, data.calls) : null), [selected, data.calls]);

  function toggleFlag(flag: Flag): void {
    setFlags((current) => {
      const next = new Set(current);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
  }

  function toggleCollapsed(spanId: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(spanId)) next.delete(spanId);
      else next.add(spanId);
      return next;
    });
  }

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

  const copyFix = (value: string): void => {
    onCopy(value);
    onNotice('Copied — send it to the app’s developer.');
  };

  // With the detail open the list is narrow: the path matters more than the summary and the waterfall.
  const compact = Boolean(selected || draft);
  const columns: Array<VirtualTableColumn<Row>> = [
    {
      key: 'path',
      header: 'Call',
      width: 'auto',
      render: ({ call, depth, childCount }) => {
        const layer = serverCallLayer(call);
        const tmf = layer === 'tmf' ? serverCallTmf(call) : null;
        const folded = collapsed.has(call.spanId);
        return (
          <span className="tree-path">
            {depth > 0 ? <span className={`indent d${depth}`} aria-hidden="true" /> : null}
            {childCount > 0 ? (
              <button
                type="button"
                className="twisty"
                aria-expanded={!folded}
                aria-label={folded ? 'Show the calls under this one' : 'Hide the calls under this one'}
                onClick={(event) => { event.stopPropagation(); toggleCollapsed(call.spanId); }}
              ><Icon name="chevron" size={12} /></button>
            ) : depth === 0 ? <span className="twisty" aria-hidden="true" /> : null}
            {layer === 'service' ? (
              <span className="tag kind-service" title={`Backend · ${call.origin}`}>{serverCallService(call)}</span>
            ) : tmf ? (
              <span className="tag kind-tmf" title={call.layer ? `${call.serviceName} called this through the ApiLens relay (route ${call.layer})` : `The BFF called this TMF API directly · ${call.origin}`}>{tmf.id}</span>
            ) : (
              <span className={`tag ${serverCallKindClass(call)}`}>{serverCallKindLabel(call)}</span>
            )}
            {tmf?.name ? <span className="tmf-name">{tmf.name}</span> : null}
            <span className={`method-label ${call.method.toLowerCase()}`}>{call.method}</span>
            <span className="path-main" title={call.url}>{call.path || call.url}</span>
            {call.layer && depth === 0 ? <span className="via" title="The call that made it is not in the list">via {call.serviceName}</span> : null}
            {call.mockedBy ? <span className="tag mock" title={`Answered by your mock “${call.mockedBy}”`}>mock</span> : null}
          </span>
        );
      },
    },
    ...(compact ? [] : [{
      key: 'summary',
      header: '',
      width: '200px',
      className: 'col-summary',
      render: (row: Row) => (row.summary ? <span className="tree-path"><span className={`summary${row.depth ? ' sub' : ''}${row.depth && row.summary.includes('TMF') ? ' tmf' : ''}`} title={row.summary}>{row.summary}</span></span> : null),
    }]),
    { key: 'status', header: 'Status', width: '64px', render: ({ call }) => <span className={`status-code ${statusClass(call)}`} title={call.error ?? undefined}>{call.statusCode ?? (call.error ? 'ERR' : '—')}</span> },
    ...(compact ? [] : [{
      key: 'timeline',
      header: 'Timeline',
      width: '140px',
      render: ({ call, depth, window }: Row) => {
        const span = Math.max(1, window.end - window.start);
        const left = Math.min(98, ((call.startedAt - window.start) / span) * 100);
        const width = Math.min(100 - left, Math.max(1.5, ((call.endedAt - call.startedAt) / span) * 100));
        return (
          <span className="wf" title={`Started ${Math.round(call.startedAt - window.start)} ms into the page · took ${Math.round(call.durationMs)} ms`}>
            <i className={barClass(call, depth)} style={{ left: `${left}%`, width: `${width}%` }} />
          </span>
        );
      },
    }]),
    { key: 'duration', header: 'Time', width: '72px', className: 'num', render: ({ call }) => <span className={`dur ${call.durationMs >= SLOW_MS ? 'slow' : ''}`}>{Math.round(call.durationMs)} ms</span> },
  ];

  const status = data.status;
  const connected = Boolean(status?.connected);
  const pods = status?.pods?.length ?? 0;
  const empty = data.calls.length === 0;
  const problem = diagnosis && (diagnosis.tone === 'fail' || diagnosis.tone === 'warn') ? diagnosis : null;

  return (
    <div className="page server-view">
      <div className="page-head">
        <h1>Server calls</h1>
        {connected ? (
          <span className="chip ok" title={`Last poll ${relative(status?.lastSyncAt ?? null)}`}>
            <span className="dot" />Live · {status?.health?.serviceName}{pods > 1 ? ` · ${pods} pods` : ''}
          </span>
        ) : status?.configured ? (
          <span className="chip err"><span className="dot" />Not reachable</span>
        ) : null}
        {problem && !empty ? (
          <button className="chip warn" onClick={() => setShowDiagnosis((open) => !open)} aria-expanded={showDiagnosis}>
            <Icon name="alert" size={12} />{problem.headline}
          </button>
        ) : null}
        <div className="actions">
          {sessionId !== null ? (
            <div className="seg" role="group" aria-label="Whose calls">
              <button aria-pressed={scope === 'mine'} onClick={() => setScope('mine')} title="Calls tagged with the QA session recording in this tab">My session</button>
              <button aria-pressed={scope === 'everyone'} onClick={() => setScope('everyone')} title="Every tester and user on this server">Everyone</button>
            </div>
          ) : null}
          <button className="icon-btn" onClick={() => void data.refresh()} disabled={data.syncing} aria-label="Refresh now" title="Refresh now"><Icon name="refresh" /></button>
          <button className="btn danger sm" onClick={() => { void data.clear(); setSelected(null); }} disabled={empty}>Clear</button>
        </div>
      </div>

      {!status?.configured ? (
        <div className="empty2">
          <span className="glyph"><Icon name="server" size={22} /></span>
          <h2>See what the app’s server does behind the page</h2>
          <p>Link the app once with its address and the access token from your team lead. Every backend call the server makes while you test then shows up here, with what was sent and what came back.</p>
          <div className="row"><button className="btn primary" onClick={onSettings}>Link a server</button></div>
          <div className="steps-inline"><span><b>1</b>Link the server</span><span><b>2</b>Use the page</span><span><b>3</b>Click a call to inspect or break it</span></div>
        </div>
      ) : (
        <>
          {data.error ? (
            <div className="notice err" role="alert">
              <Icon name="alert" />
              <div><strong>Can’t reach the server.</strong><span> {data.error}</span></div>
              <button className="btn sm" onClick={onSettings}>Check the link</button>
            </div>
          ) : null}

          {mineOnly && scoped.length === 0 && hiddenByScope > 0 ? (
            <div className="notice info" role="status">
              <Icon name="info" />
              <div>
                <strong>None of the {hiddenByScope} server calls carry your session yet.</strong>
                <span> Reload the page so its requests are tagged (Settings → “Tag my traffic”), or look at everyone’s calls.</span>
              </div>
              <button className="btn sm" onClick={() => setScope('everyone')}>Show everyone</button>
            </div>
          ) : null}

          {empty && connected && !data.error && diagnosis ? (
            <div className="page-scroll" style={{ padding: 0 }}>
              <CaptureDiagnosisCard diagnosis={diagnosis} onCopy={copyFix} onRefresh={() => void data.refresh()} onOpenBrowserCalls={onOpenBrowserCalls} />
            </div>
          ) : (
            <>
              {showDiagnosis && diagnosis ? (
                <CaptureDiagnosisCard diagnosis={diagnosis} onCopy={copyFix} onClose={() => setShowDiagnosis(false)} onOpenBrowserCalls={onOpenBrowserCalls} />
              ) : null}

              <div className="toolbar">
                <label className="search grow">
                  <Icon name="search" size={14} />
                  <span className="sr-only">Filter server calls</span>
                  <input ref={searchRef} className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by path, status, service or payload text" />
                </label>
                <div className="seg" role="group" aria-label="Which calls">
                  {(['all', 'pages', 'backend', 'tmf'] as KindFilter[]).map((value) => (
                    <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)} title={value === 'tmf' ? 'TMF APIs: called by the BFF directly or, through the relay, by a JCS' : undefined}>
                      {KIND_LABELS[value]}
                    </button>
                  ))}
                </div>
                <span className="sep" aria-hidden="true" />
                <button className="fchip err" aria-pressed={flags.has('failed')} onClick={() => toggleFlag('failed')} disabled={!counts.failed && !flags.has('failed')}>Failed <b>{counts.failed}</b></button>
                <button className="fchip" aria-pressed={flags.has('slow')} onClick={() => toggleFlag('slow')} disabled={!counts.slow && !flags.has('slow')} title={`Took ${SLOW_MS / 1000} s or more`}>Slow <b>{counts.slow}</b></button>
                <button className="fchip mock" aria-pressed={flags.has('mocked')} onClick={() => toggleFlag('mocked')} disabled={!counts.mocked && !flags.has('mocked')}>Mocked <b>{counts.mocked}</b></button>
                <button className="fchip cache" aria-pressed={flags.has('cached')} onClick={() => toggleFlag('cached')} disabled={!counts.cached && !flags.has('cached')} title="Answered by Next’s cache: no backend call happened">Cached <b>{counts.cached}</b></button>
                <span className="sep" aria-hidden="true" />
                <div className="seg" role="group" aria-label="Layout">
                  <button aria-pressed={grouped} onClick={() => setGrouped(true)} title="Each page with the calls it caused">By page</button>
                  <button aria-pressed={!grouped} onClick={() => setGrouped(false)} title="Every call in time order">Flat</button>
                </div>
              </div>

              <div className="page-body request-area">
                <div className="list calls">
                  <VirtualTable
                    items={rows}
                    columns={columns}
                    rowHeight={30}
                    selectedId={draft ? null : selected?.spanId}
                    onSelect={(row) => { setDraft(null); setSelected(row.call); }}
                    getId={(row) => row.call.spanId}
                    getRowClass={({ call, depth }) => `${depth ? 'child' : 'root'} layer-${serverCallLayer(call)} ${call.status === 'error' ? 'failed' : ''} ${call.mockedBy ? 'mocked' : ''}`}
                    emptyTitle={connected ? 'No calls match' : 'Waiting for the server'}
                    emptyHint={connected ? 'Clear the search or the filters to see every call.' : 'Polling the control endpoint…'}
                  />
                </div>
                {draft ? (
                  <aside className="drawer" aria-label="Simulate a problem">
                    <div className="drawer-bar">
                      <button className="btn ghost sm" onClick={() => setDraft(null)}>← Back to the call</button>
                      <button className="icon-btn" onClick={() => { setDraft(null); setSelected(null); }} aria-label="Close"><Icon name="close" /></button>
                    </div>
                    <div className="drawer-body">
                      <ServerMockEditor
                        rule={draft.rule}
                        saving={saving}
                        sampleBody={draft.sample}
                        onChange={(rule) => setDraft({ ...draft, rule })}
                        onCancel={() => setDraft(null)}
                        onSave={(enable) => {
                          const saved = { ...draft.rule, enabled: enable, updatedAt: Date.now() };
                          void persist(
                            [...data.rules.filter((rule) => rule.id !== saved.id), saved],
                            enable ? `“${saved.name}” is on. Repeat the step in the app now.` : `“${saved.name}” saved and kept off.`,
                          );
                        }}
                      />
                    </div>
                  </aside>
                ) : selected ? (
                  <ServerCallDetail
                    call={selected}
                    related={related}
                    onSelectRelated={setSelected}
                    onClose={() => setSelected(null)}
                    onMock={(call) => setDraft({ rule: serverRuleFromCall(call), sample: call.responseBody?.encoding === 'utf8' ? call.responseBody.content : null })}
                    mockingEnabled={status?.health?.mockingEnabled !== false}
                    onOpenMocks={onOpenMocks}
                    onCopy={(value) => { onCopy(value); onNotice('Copied to clipboard.'); }}
                  />
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
