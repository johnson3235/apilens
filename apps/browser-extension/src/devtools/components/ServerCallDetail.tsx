import { useState } from 'react';
import { describeStatus, explainServerCall, serverCallHost, serverCallKindLabel, type ServerCall } from '../../shared/server-control';
import { BodyViewer } from './BodyViewer';
import { Icon } from './Icon';

type DetailTab = 'overview' | 'request' | 'response' | 'headers';

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'request', label: 'Sent' },
  { id: 'response', label: 'Received' },
  { id: 'headers', label: 'Headers' },
];

type Related = { parent: ServerCall | null; children: ServerCall[]; middleware?: ServerCall | null };

function statusTone(call: ServerCall): string {
  if (call.statusCode === null) return call.error ? 'err' : 'none';
  return call.statusCode >= 400 ? 'err' : call.statusCode >= 300 ? 'redirect' : 'ok';
}

function FlowRow({ call, onSelect }: { call: ServerCall; onSelect: (call: ServerCall) => void }): JSX.Element {
  const label = serverCallKindLabel(call);
  return (
    <button type="button" className="flow-row" onClick={() => onSelect(call)}>
      <span className={`tag kind-${label.toLowerCase()}`}>{label}</span>
      <span className={`method-label ${call.method.toLowerCase()}`}>{call.method}</span>
      <span className="p">{call.kind === 'client' ? `${serverCallHost(call)}${call.path}` : call.path}</span>
      <span className={`status-code ${statusTone(call)}`}>{call.statusCode ?? (call.error ? 'ERR' : '—')}</span>
      <span className="dur">{Math.round(call.durationMs)} ms</span>
    </button>
  );
}

function KeyValues({ title, entries, empty }: { title: string; entries: Array<[string, string]>; empty: string }): JSX.Element {
  return (
    <>
      <div className="kv-title">{title} <span>({entries.length})</span></div>
      {entries.length === 0 ? <p className="muted">{empty}</p> : (
        <dl className="kv">
          {entries.map(([name, value]) => (
            <div key={name}><dt>{name}</dt><dd className={value === '[REDACTED]' ? 'redacted' : ''}>{value}</dd></div>
          ))}
        </dl>
      )}
    </>
  );
}

export function ServerCallDetail({
  call,
  related,
  onSelectRelated,
  onClose,
  onMock,
  onCopy,
  mockingEnabled = true,
  onOpenMocks,
}: {
  call: ServerCall;
  related?: Related | null;
  onSelectRelated?: (call: ServerCall) => void;
  onClose: () => void;
  onMock: (call: ServerCall) => void;
  onCopy: (value: string) => void;
  mockingEnabled?: boolean;
  onOpenMocks?: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<DetailTab>('overview');
  const query = Object.entries(call.query);
  const label = serverCallKindLabel(call);
  const select = onSelectRelated ?? (() => undefined);
  const page = related?.parent ?? null;
  const tone = call.mockedBy ? 'mock' : call.cache === 'hit' ? 'cache' : call.status === 'error' ? 'err' : '';

  return (
    <aside className="drawer right server-detail" aria-label="Selected server call">
      <div className="drawer-head preview-head">
        <div className="title">
          <div className="line">
            <span className={`tag kind-${label.toLowerCase()}`}>{label}</span>
            <span className={`method-label ${call.method.toLowerCase()}`}>{call.method}</span>
            <strong title={call.url}>{call.path || call.url}</strong>
          </div>
          <div className="meta">
            <span className={`status-code ${statusTone(call)}`}>{describeStatus(call)}</span>
            <span className="muted">·</span>
            <span className="dur">{Math.round(call.durationMs)} ms</span>
            {call.mockedBy ? <span className="tag mock">mocked</span> : null}
            {call.cache === 'hit' ? <span className="tag cache">from cache</span> : null}
          </div>
          {page && onSelectRelated ? (
            <div className="crumbs">
              <span>Part of</span>
              <button onClick={() => select(page)} title={page.url}>{page.stage === 'middleware' ? 'middleware ' : ''}{page.path}</button>
            </div>
          ) : null}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="close" /></button>
      </div>

      <div className="tabs2 detail-tabs" role="tablist" aria-label="Server call details">
        {TABS.map((item) => (
          <button key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
            {item.id === 'request' && call.requestBody ? <i aria-hidden="true">•</i> : null}
            {item.id === 'response' && call.responseBody ? <i aria-hidden="true">•</i> : null}
          </button>
        ))}
      </div>

      <div className="drawer-body">
        {tab === 'overview' ? (
          <>
            <p className={`story ${tone}`}>{explainServerCall(call)}</p>

            <div className="facts">
              <div><span>Result</span><strong className={call.status === 'error' ? 'error-text' : ''}>{describeStatus(call)}</strong></div>
              <div><span>Time</span><strong>{Math.round(call.durationMs)} ms{call.bodyDurationMs !== null ? ` · body ${Math.round(call.bodyDurationMs)} ms` : ''}</strong></div>
              <div><span>Service</span><strong title={call.serviceName}>{call.serviceName}</strong></div>
              <div><span>Answered by</span><strong className={call.mockedBy ? 'mock-text' : ''}>{call.mockedBy ? `mock “${call.mockedBy}”` : call.cache === 'hit' ? 'Next cache' : call.kind === 'client' ? serverCallHost(call) : 'this server'}</strong></div>
            </div>

            {call.error ? <div className="notice err" style={{ margin: '0 0 14px' }}><Icon name="alert" /><div><strong>{call.error}</strong></div></div> : null}

            {related?.middleware && onSelectRelated ? (
              <>
                <div className="kv-title">Checked first by the middleware</div>
                <div className="flow-list"><FlowRow call={related.middleware} onSelect={select} /></div>
              </>
            ) : null}

            {related && related.children.length && onSelectRelated ? (
              <>
                <div className="kv-title">{call.stage === 'middleware' ? 'Calls the middleware made' : 'Backend calls made to answer it'} ({related.children.length})</div>
                <div className="flow-list">{related.children.map((child) => <FlowRow key={child.spanId} call={child} onSelect={select} />)}</div>
              </>
            ) : null}

            <div className="kv-title">Full address</div>
            <div className="mono wrap" style={{ fontSize: 11.5 }}>{call.url}</div>

            {query.length ? <KeyValues title="Query parameters" entries={query} empty="" /> : null}

            <KeyValues
              title="Correlation"
              entries={[
                ['trace', call.traceId],
                ['span', call.spanId],
                ['parent', call.parentSpanId ?? '—'],
                ['session', call.sessionId],
                ...(call.middlewareSpanId ? [['middleware', call.middlewareSpanId] as [string, string]] : []),
              ]}
              empty=""
            />
          </>
        ) : null}

        {tab === 'request' ? (
          <BodyViewer
            body={call.requestBody}
            omitted={call.requestBodyOmitted}
            label="No request payload"
            emptyHint={call.method === 'GET' ? 'GET requests usually carry no body.' : 'Enable captureBodies.request on the server SDK.'}
            onCopy={onCopy}
          />
        ) : null}

        {tab === 'response' ? (
          <BodyViewer
            body={call.responseBody}
            omitted={call.responseBodyOmitted}
            label="No response payload"
            emptyHint="Enable captureBodies.response on the server SDK."
            onCopy={onCopy}
          />
        ) : null}

        {tab === 'headers' ? (
          <>
            <KeyValues title="Request headers" entries={Object.entries(call.requestHeaders)} empty="None captured." />
            <KeyValues title="Response headers" entries={Object.entries(call.responseHeaders)} empty="None captured." />
            <p className="muted" style={{ marginTop: 12 }}>Credential-like headers are replaced on the server before capture, so they never reach this panel.</p>
          </>
        ) : null}
      </div>

      <div className="drawer-foot detail-actions">
        <button
          className="btn primary"
          onClick={() => onMock(call)}
          disabled={!mockingEnabled}
          title={mockingEnabled ? 'Make this call fail or answer differently, then repeat the step in the app' : 'Server mocks are disabled for this deployment'}
        >
          <Icon name="bolt" size={13} />Simulate a problem
        </button>
        {call.mockedBy && onOpenMocks ? <button className="btn" onClick={onOpenMocks}>Manage mocks</button> : null}
        <button className="btn" onClick={() => onCopy(call.url)}><Icon name="copy" size={13} />Copy URL</button>
        <button className="btn" onClick={() => onCopy(JSON.stringify(call, null, 2))}>Copy as JSON</button>
      </div>
    </aside>
  );
}
