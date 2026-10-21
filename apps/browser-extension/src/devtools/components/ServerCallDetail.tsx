import { useState } from 'react';
import { describeStatus, explainServerCall, type ServerCall } from '../../shared/server-control';
import { BodyViewer } from './BodyViewer';

type DetailTab = 'overview' | 'request' | 'response' | 'headers';

const TABS: Array<{ id: DetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'request', label: 'Sent' },
  { id: 'response', label: 'Received' },
  { id: 'headers', label: 'Headers' },
];

function FlowLink({ call, onSelect }: { call: ServerCall; onSelect: (call: ServerCall) => void }): JSX.Element {
  return (
    <button type="button" className={`flow-link ${call.status === 'error' ? 'failed' : ''}`} onClick={() => onSelect(call)}>
      <span className={`dir ${call.kind}`}>{call.kind === 'server' ? 'PAGE' : 'BACKEND'}</span>
      <span className={`method ${call.method.toLowerCase()}`}>{call.method}</span>
      <span className="mono path-text">{call.kind === 'client' ? `${call.origin.replace(/^https?:\/\//, '')}${call.path}` : call.path}</span>
      {call.mockedBy ? <span className="badge mock">mock</span> : null}
      <span className={`status-pill ${call.status}`}>{call.statusCode ?? (call.error ? 'ERR' : '—')}</span>
      <span className="muted num">{Math.round(call.durationMs)} ms</span>
    </button>
  );
}

function CallFlow({
  related,
  onSelect,
}: {
  related: { parent: ServerCall | null; children: ServerCall[] };
  onSelect: (call: ServerCall) => void;
}): JSX.Element | null {
  if (!related.parent && related.children.length === 0) return null;
  return (
    <section className="header-block call-flow">
      {related.parent ? (
        <>
          <h4>Made while answering this page call</h4>
          <FlowLink call={related.parent} onSelect={onSelect} />
        </>
      ) : (
        <>
          <h4>Backend calls made to answer it <span className="muted">({related.children.length})</span></h4>
          {related.children.map((child) => <FlowLink key={child.spanId} call={child} onSelect={onSelect} />)}
        </>
      )}
    </section>
  );
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, string> }): JSX.Element {
  const entries = Object.entries(headers);
  return (
    <section className="header-block">
      <h4>{title} <span className="muted">({entries.length})</span></h4>
      {entries.length === 0 ? (
        <p className="muted">None captured.</p>
      ) : (
        <dl className="header-list">
          {entries.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd className={value === '[REDACTED]' ? 'redacted' : ''}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function ServerCallDetail({
  call,
  related,
  onSelectRelated,
  onClose,
  onMock,
  onCopy,
}: {
  call: ServerCall;
  related?: { parent: ServerCall | null; children: ServerCall[] } | null;
  onSelectRelated?: (call: ServerCall) => void;
  onClose: () => void;
  onMock: (call: ServerCall) => void;
  onCopy: (value: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<DetailTab>('overview');
  const query = Object.entries(call.query);

  return (
    <aside className="right server-detail" aria-label="Selected server call">
      <div className="preview-head">
        <div className="detail-title">
          <span className={`method ${call.method.toLowerCase()}`}>{call.method}</span>
          <strong className="mono">{call.path || call.url}</strong>
        </div>
        <button className="btn sm" onClick={onClose}>Close</button>
      </div>

      <div className="detail-tabs" role="tablist" aria-label="Server call details">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'request' && call.requestBody ? <i aria-hidden="true">•</i> : null}
            {item.id === 'response' && call.responseBody ? <i aria-hidden="true">•</i> : null}
          </button>
        ))}
      </div>

      <div className="scroll pad">
        {tab === 'overview' ? (
          <>
            <p className={`call-story ${call.status === 'error' ? 'failed' : ''} ${call.mockedBy ? 'mocked' : ''}`}>{explainServerCall(call)}</p>

            <div className="eyebrow">Full address</div>
            <div className="mono wrap">{call.url}</div>

            <div className="preview-grid">
              <div><span>Result</span><strong className={call.status === 'error' ? 'error-text' : ''}>{describeStatus(call)}</strong></div>
              <div><span>Duration</span><strong>{Math.round(call.durationMs)} ms</strong></div>
              <div><span>Type</span><strong>{call.kind === 'server' ? 'Page → this server' : 'Server → backend'}</strong></div>
              <div><span>Service</span><strong>{call.serviceName}</strong></div>
              <div><span>Mocked</span><strong className={call.mockedBy ? 'mock-text' : ''}>{call.mockedBy ?? 'No'}</strong></div>
              <div><span>Body time</span><strong>{call.bodyDurationMs === null ? '—' : `${Math.round(call.bodyDurationMs)} ms`}</strong></div>
            </div>

            {call.error ? <div className="error-card">{call.error}</div> : null}

            {related && onSelectRelated ? <CallFlow related={related} onSelect={onSelectRelated} /> : null}

            {query.length ? (
              <section className="header-block">
                <h4>Query parameters <span className="muted">({query.length})</span></h4>
                <dl className="header-list">
                  {query.map(([name, value]) => (
                    <div key={name}><dt>{name}</dt><dd className={value === '[REDACTED]' ? 'redacted' : ''}>{value}</dd></div>
                  ))}
                </dl>
              </section>
            ) : null}

            <section className="header-block">
              <h4>Correlation</h4>
              <dl className="header-list">
                <div><dt>trace</dt><dd className="mono">{call.traceId}</dd></div>
                <div><dt>span</dt><dd className="mono">{call.spanId}</dd></div>
                <div><dt>parent</dt><dd className="mono">{call.parentSpanId ?? '—'}</dd></div>
                <div><dt>session</dt><dd className="mono">{call.sessionId}</dd></div>
              </dl>
            </section>
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
            <HeaderTable title="Request headers" headers={call.requestHeaders} />
            <HeaderTable title="Response headers" headers={call.responseHeaders} />
            <p className="muted">Credential-like headers are replaced on the server before capture, so they never reach this panel.</p>
          </>
        ) : null}
      </div>

      <div className="detail-actions sticky">
        <button className="btn primary" onClick={() => onMock(call)}>Simulate a problem</button>
        <button className="btn" onClick={() => onCopy(call.url)}>Copy URL</button>
        <button className="btn" onClick={() => onCopy(JSON.stringify(call, null, 2))}>Copy as JSON</button>
      </div>
    </aside>
  );
}
