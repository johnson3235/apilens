import { useEffect, useMemo, useRef, useState } from 'react';
import type { CapturedRequest, ContractSet, ResponseAssertion, Rule, TraceTree } from '@apilens/shared-types';
import { VirtualTable, type VirtualTableColumn } from '../components/VirtualTable';
import { ChannelBadge, MethodLabel, StatusBadge } from '../components/Badges';
import { RequestDetail } from '../components/RequestDetail';
import { QuerySearch } from '../components/QuerySearch';
import { ExtractMenu } from '../components/ExtractMenu';
import { BrowserMockEditor } from '../components/BrowserMockEditor';
import {
  TRAFFIC_CLASSES,
  filterRequests,
  groupByPage,
  pageKeyOf,
  pageLabelOf,
  type PageScope,
  type TrafficClass,
} from '../../shared/request-query';

type Outcome = 'any' | 'failed' | 'mocked' | 'slow' | 'pending';

const OUTCOMES: Array<{ id: Outcome; label: string; hint: string }> = [
  { id: 'any', label: 'Any', hint: 'No outcome filter' },
  { id: 'failed', label: 'Failed', hint: '4xx, 5xx and transport errors' },
  { id: 'mocked', label: 'Mocked', hint: 'Responses produced by a QA rule' },
  { id: 'slow', label: 'Slow', hint: 'Slower than the configured threshold' },
  { id: 'pending', label: 'Pending', hint: 'Still in flight or never completed' },
];

function duration(request: CapturedRequest): string {
  return request.timing.durationMs === null ? '—' : `${Math.round(request.timing.durationMs)} ms`;
}

function size(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function matchesOutcome(request: CapturedRequest, outcome: Outcome, slowMs: number): boolean {
  switch (outcome) {
    case 'failed': return Boolean(request.error) || (request.statusCode ?? 0) >= 400;
    case 'mocked': return request.mock !== null;
    case 'slow': return (request.timing.durationMs ?? 0) >= slowMs;
    case 'pending': return request.timing.completedAt === null;
    default: return true;
  }
}

/**
 * Explains an empty list in terms of the control that caused it.
 *
 * "No results" is the moment a tester loses trust in a filter; naming the
 * responsible filter — and offering the undo — keeps them moving.
 */
function EmptyExplanation({
  outcome,
  onClearQuery,
  onShowAll,
  onAllPages,
  recording,
}: {
  outcome: ReturnType<typeof filterRequests>;
  onClearQuery: () => void;
  onShowAll: () => void;
  onAllPages: () => void;
  recording: boolean;
}): JSX.Element {
  if (outcome.total === 0) {
    return (
      <div className="empty-state">
        <span aria-hidden="true">◎</span>
        <h2>{recording ? 'Waiting for traffic' : 'No calls captured yet'}</h2>
        <p>
          {recording
            ? 'Use the application in the inspected tab. Calls appear here the moment the page makes them.'
            : 'Press “Start QA session” in the header, reload the inspected page, then perform the journey you want to test.'}
        </p>
      </div>
    );
  }

  const reasons: Array<{ count: number; label: string; action: string; onAction: () => void }> = [
    { count: outcome.hiddenByTraffic, label: 'hidden by the traffic-type filter', action: 'Show everything', onAction: onShowAll },
    { count: outcome.hiddenByScope, label: 'hidden because they came from another page', action: 'Show all pages', onAction: onAllPages },
    { count: outcome.hiddenByQuery, label: 'hidden by your search', action: 'Clear the search', onAction: onClearQuery },
  ].filter((reason) => reason.count > 0);

  return (
    <div className="empty-state">
      <span aria-hidden="true">⌕</span>
      <h2>No calls match the current filters</h2>
      <p>{outcome.total} captured call(s), all filtered out.</p>
      <ul className="empty-reasons">
        {reasons.map((reason) => (
          <li key={reason.label}>
            <span><b>{reason.count}</b> {reason.label}</span>
            <button className="btn sm" onClick={reason.onAction}>{reason.action}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NetworkView({
  requests,
  traces,
  assertions,
  contracts,
  rules,
  slowRequestMs,
  environmentName,
  mockingBlockedReason,
  recording,
  currentPageUrl,
  captureStaticAssets,
  version,
  busy,
  onRefresh,
  onClear,
  onSaveRule,
  onReplay,
  onOpenTrace,
  onBookmark,
  onEnableStaticCapture,
  onNotice,
}: {
  requests: CapturedRequest[];
  traces: TraceTree[];
  assertions: ResponseAssertion[];
  contracts: ContractSet[];
  rules: Rule[];
  slowRequestMs: number;
  environmentName: string | null;
  mockingBlockedReason: string | null;
  recording: boolean;
  currentPageUrl: string | null;
  /** Assets are dropped at capture time when this is off. */
  captureStaticAssets: boolean;
  version: string;
  busy: boolean;
  onRefresh: () => void;
  onClear: () => void;
  onSaveRule: (rules: Rule[], notice: string) => Promise<void>;
  onReplay: (request: CapturedRequest) => void;
  onOpenTrace: (traceId: string) => void;
  onBookmark: (request: CapturedRequest) => void;
  onEnableStaticCapture: () => void;
  onNotice: (message: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [traffic, setTraffic] = useState<TrafficClass>('api');
  const [scope, setScope] = useState<PageScope>({ mode: 'all' });
  const [outcome, setOutcome] = useState<Outcome>('any');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mockDraft, setMockDraft] = useState<{ request: CapturedRequest | null; existing: Rule | null } | null>(null);

  // A DevTools panel is often docked narrow. Columns are dropped by priority
  // rather than squeezed, so what remains stays readable instead of truncating
  // every cell to nothing.
  const listRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(900);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setListWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setListWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const currentPageKey = pageKeyOf(currentPageUrl);
  const pages = useMemo(() => groupByPage(requests), [requests]);

  const filtered = useMemo(
    () => filterRequests(requests, { query, traffic, scope, currentPageKey }),
    [requests, query, traffic, scope, currentPageKey],
  );

  const visible = useMemo(
    () => filtered.requests.filter((request) => matchesOutcome(request, outcome, slowRequestMs)),
    [filtered.requests, outcome, slowRequestMs],
  );

  const selected = useMemo(
    () => visible.find((request) => request.id === selectedId) ?? requests.find((request) => request.id === selectedId) ?? null,
    [visible, requests, selectedId],
  );

  // A selection that scrolls out of the filtered set should not leave a stale
  // detail panel pinned open.
  useEffect(() => {
    if (selectedId && !requests.some((request) => request.id === selectedId)) setSelectedId(null);
  }, [requests, selectedId]);

  const stats = useMemo(() => {
    const failed = visible.filter((request) => request.error || (request.statusCode ?? 0) >= 400).length;
    const mocked = visible.filter((request) => request.mock).length;
    const slow = visible.filter((request) => (request.timing.durationMs ?? 0) >= slowRequestMs).length;
    const bytes = visible.reduce((total, request) => total + (request.responseBody?.byteLength ?? 0), 0);
    return { failed, mocked, slow, bytes };
  }, [visible, slowRequestMs]);

  const columns: Array<VirtualTableColumn<CapturedRequest>> = useMemo(() => {
    const showPage = listWidth >= 820 && scope.mode === 'all';
    const showHost = listWidth >= 700;
    const showSource = listWidth >= 620;
    const showSize = listWidth >= 540;

    return [
      { key: 'method', header: 'Method', width: '58px', className: 'mono', render: (request) => <MethodLabel method={request.method} /> },
      { key: 'status', header: 'Status', width: '60px', className: 'status', render: (request) => <StatusBadge request={request} /> },
      { key: 'path', header: 'Endpoint', width: 'auto', className: 'mono grow-cell', render: (request) => request.path || request.url },
      ...(showHost ? [{ key: 'host', header: 'Host', width: '15%', render: (request: CapturedRequest) => request.hostname }] : []),
      ...(showPage ? [{ key: 'page', header: 'Page', width: '13%', render: (request: CapturedRequest) => <span className="muted">{request.pageUrl ? pageLabelOf(pageKeyOf(request.pageUrl) ?? request.pageUrl) : '—'}</span> }] : []),
      ...(showSource ? [{ key: 'channel', header: 'Source', width: '86px', render: (request: CapturedRequest) => <ChannelBadge channel={request.channel} /> }] : []),
      ...(showSize ? [{ key: 'size', header: 'Size', width: '64px', className: 'num', render: (request: CapturedRequest) => size(request.responseBody?.byteLength ?? 0) }] : []),
      { key: 'duration', header: 'Duration', width: '72px', className: 'num', render: duration },
    ];
  }, [listWidth, scope.mode]);

  function startMock(request: CapturedRequest): void {
    setMockDraft({ request, existing: null });
  }

  async function saveRule(rule: Rule): Promise<void> {
    const others = rules.filter((item) => item.id !== rule.id);
    await onSaveRule([...others, rule], `“${rule.name}” saved. Enable it when you are ready for traffic to change.`);
    setMockDraft(null);
  }

  if (mockDraft) {
    return (
      <div className="content">
        <div className="view-header">
          <div>
            <span className="overline">CONTROLLED FAILURE TESTING</span>
            <h1>Mock a browser call</h1>
            <p>The page will receive this response instead of the real one. Nothing reaches the network.</p>
          </div>
          <div className="view-actions">
            <button className="btn" onClick={() => setMockDraft(null)}>Back to calls</button>
          </div>
        </div>
        <div className="scroll view-page">
          <BrowserMockEditor
            request={mockDraft.request}
            existing={mockDraft.existing}
            environmentName={environmentName}
            blockedReason={mockingBlockedReason}
            saving={busy}
            onSave={(rule) => void saveRule(rule)}
            onCancel={() => setMockDraft(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="content network-view">
      <div className="view-header">
        <div>
          <span className="overline">LIVE BROWSER CAPTURE</span>
          <h1>Network calls</h1>
          <p>Every request the page makes — inspect the payload, mock the failure, extract the evidence.</p>
        </div>
        <div className="view-actions">
          <ExtractMenu requests={visible} label="apilens-network" version={version} onNotice={onNotice} />
          <button className="btn" onClick={onRefresh}>Refresh</button>
          <button className="btn danger" onClick={onClear}>Clear</button>
        </div>
      </div>

      <div className="filter-stack">
        <QuerySearch value={query} onChange={setQuery} parsed={filtered.parsed} shown={visible.length} total={requests.length} />

        {/* Assets are discarded at capture time unless explicitly enabled, so
            selecting the filter alone can never reveal them. Say so here
            rather than letting the list look mysteriously empty. */}
        {!captureStaticAssets && (traffic === 'assets' || traffic === 'all') ? (
          <div className="banner info">
            <div>
              <strong>Static assets are not being captured.</strong>
              <span> Scripts, styles, images and fonts are discarded at capture time to keep sessions small, so this filter has nothing to show.</span>
            </div>
            <button className="btn sm" onClick={onEnableStaticCapture}>Capture them from now on</button>
          </div>
        ) : null}

        <div className="filter-row">
          <div className="filter-group">
            <span className="filter-label" id="apilens-traffic-label">Show</span>
            <div className="segmented sm" role="group" aria-labelledby="apilens-traffic-label">
              {TRAFFIC_CLASSES.map((item) => (
                <button key={item.id} title={item.hint} className={traffic === item.id ? 'active' : ''} onClick={() => setTraffic(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <span className="filter-label" id="apilens-outcome-label">Outcome</span>
            <div className="segmented sm" role="group" aria-labelledby="apilens-outcome-label">
              {OUTCOMES.map((item) => (
                <button key={item.id} title={item.hint} className={outcome === item.id ? 'active' : ''} onClick={() => setOutcome(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group grow">
            <span className="filter-label" id="apilens-page-label">Page</span>
            <div className="segmented sm" role="group" aria-labelledby="apilens-page-label">
              <button className={scope.mode === 'all' ? 'active' : ''} onClick={() => setScope({ mode: 'all' })} title="Calls from every page in this session">
                All pages
              </button>
              <button
                className={scope.mode === 'current' ? 'active' : ''}
                onClick={() => setScope({ mode: 'current' })}
                disabled={!currentPageKey}
                title={currentPageKey ? `Only calls from ${pageLabelOf(currentPageKey)}` : 'No inspected page detected'}
              >
                This page
              </button>
            </div>
            <label className="page-picker">
              <span className="sr-only">Choose a specific page</span>
              <select
                className="input"
                value={scope.mode === 'page' ? scope.key : ''}
                onChange={(event) => setScope(event.target.value ? { mode: 'page', key: event.target.value } : { mode: 'all' })}
              >
                <option value="">Pick a page…</option>
                {pages.map((page) => (
                  <option key={page.key} value={page.key}>
                    {page.label} · {page.count} call{page.count === 1 ? '' : 's'}{page.errorCount ? ` · ${page.errorCount} failed` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="metric-row">
        <div><span>Shown</span><strong>{visible.length}</strong></div>
        <div><span>Failed</span><strong className={stats.failed ? 'error-text' : ''}>{stats.failed}</strong></div>
        <div><span>Mocked</span><strong className="mock-text">{stats.mocked}</strong></div>
        <div><span>Slow</span><strong className={stats.slow ? 'warn-text' : ''}>{stats.slow}</strong></div>
        <div><span>Pages</span><strong>{pages.length}</strong></div>
        <div><span>Payload</span><strong>{size(stats.bytes)}</strong></div>
      </div>

      <div className="split request-area">
        <div className="left" ref={listRef}>
          {visible.length === 0 ? (
            <EmptyExplanation
              outcome={filtered}
              recording={recording}
              onClearQuery={() => setQuery('')}
              onShowAll={() => setTraffic('all')}
              onAllPages={() => setScope({ mode: 'all' })}
            />
          ) : (
            <VirtualTable
              items={visible}
              columns={columns}
              selectedId={selectedId}
              onSelect={(request) => setSelectedId(request.id)}
              getId={(request) => request.id}
              getRowClass={(request) => `${request.error || (request.statusCode ?? 0) >= 400 ? 'failed' : ''} ${request.mock ? 'mocked' : ''}`}
              emptyTitle="No API traffic yet"
              emptyHint="Start a QA session, reload the inspected page, then perform the customer journey."
            />
          )}
        </div>

        {selected ? (
          <aside className="right request-preview" aria-label="Selected call details">
            <div className="preview-head">
              <div className="detail-title">
                <MethodLabel method={selected.method} />
                <strong className="mono">{selected.path || selected.url}</strong>
              </div>
              <button className="btn sm" onClick={() => setSelectedId(null)}>Close</button>
            </div>
            <RequestDetail
              request={selected}
              allRequests={requests}
              traces={traces}
              assertions={assertions}
              contracts={contracts}
              onCreateMock={startMock}
              onReplay={onReplay}
              onOpenTrace={onOpenTrace}
              onBookmark={onBookmark}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
