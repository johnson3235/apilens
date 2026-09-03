import { Fragment, useMemo, useState } from 'react';
import type { CapturedRequest, ContractSet, ResponseAssertion } from '@apilens/shared-types';
import { formatBytes, formatClock, formatDuration } from '@apilens/core';
import { buildReplayRequest } from '@apilens/replay-engine';
import { generateCode, CODE_TARGETS } from '@apilens/replay-engine';
import { runAssertions, validateResponse } from '@apilens/contract-validation';
import { explainFailure } from '@apilens/insights';
import type { TraceTree } from '@apilens/shared-types';
import { JsonViewer } from './JsonViewer';
import { ChannelBadge, StatusBadge } from './Badges';
import { copyToClipboard } from '../hooks/bridge';

type DetailTab = 'summary' | 'request' | 'response' | 'trace' | 'checks' | 'code';

interface RequestDetailProps {
  request: CapturedRequest;
  allRequests: CapturedRequest[];
  traces: TraceTree[];
  assertions: ResponseAssertion[];
  contracts: ContractSet[];
  onCreateMock: (request: CapturedRequest) => void;
  onReplay: (request: CapturedRequest) => void;
  onOpenTrace: (traceId: string) => void;
  onBookmark: (request: CapturedRequest) => void;
}

function HeaderTable({ headers, redacted }: { headers: Record<string, string>; redacted: string[] }): JSX.Element {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <div className="muted">No headers captured for this observation. Browser APIs may expose only a subset.</div>;
  return (
    <dl className="kv">
      {entries.map(([name, value]) => (
        <Fragment key={name}>
          <dt>
            {name}
            {redacted.includes(name.toLowerCase()) ? ' 🔒' : ''}
          </dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function RequestDetail({
  request,
  allRequests,
  traces,
  assertions,
  contracts,
  onCreateMock,
  onReplay,
  onOpenTrace,
  onBookmark,
}: RequestDetailProps): JSX.Element {
  const [tab, setTab] = useState<DetailTab>('summary');
  const [codeTarget, setCodeTarget] = useState(CODE_TARGETS[0]!.id);
  const [copied, setCopied] = useState(false);

  const replay = useMemo(() => buildReplayRequest(request).request, [request]);
  const code = useMemo(() => generateCode(replay, { target: codeTarget }), [replay, codeTarget]);
  const assertionResults = useMemo(() => runAssertions(assertions, request), [assertions, request]);
  const schemaResult = useMemo(() => validateResponse(request, contracts), [request, contracts]);
  const failure = useMemo(
    () => (request.error || (request.statusCode ?? 0) >= 400 ? explainFailure(request, allRequests, traces) : null),
    [request, allRequests, traces],
  );

  const redactedRequestHeaders = request.redactedFields
    .filter((field) => field.startsWith('request.header:'))
    .map((field) => field.replace('request.header:', ''));
  const redactedResponseHeaders = request.redactedFields
    .filter((field) => field.startsWith('response.header:'))
    .map((field) => field.replace('response.header:', ''));

  const copy = async (value: string): Promise<void> => {
    setCopied(await copyToClipboard(value));
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <>
      <div className="toolbar" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['summary', 'request', 'response', 'trace', 'checks', 'code'] as DetailTab[]).map((item) => (
          <button key={item} type="button" className="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </div>

      <div className="scroll pad">
        {tab === 'summary' ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <StatusBadge request={request} />
              <ChannelBadge channel={request.channel} />
              {request.mock ? <span className="badge mock">rule: {request.mock.ruleName}</span> : null}
              {request.retryAttempt > 0 ? <span className="badge warn">retry #{request.retryAttempt}</span> : null}
              <span className="spacer" />
              <button type="button" className="btn sm" onClick={() => onBookmark(request)}>
                Bookmark
              </button>
              <button type="button" className="btn sm" onClick={() => onReplay(request)}>
                Replay
              </button>
              <button type="button" className="btn sm" onClick={() => onCreateMock(request)}>
                Mock this
              </button>
            </div>

            <dl className="kv">
              <dt>Method</dt>
              <dd>{request.method}</dd>
              <dt>URL</dt>
              <dd>{request.url}</dd>
              <dt>Host</dt>
              <dd>
                {request.hostname}
                {request.port ? `:${request.port}` : ''}
              </dd>
              <dt>Path</dt>
              <dd>{request.path}</dd>
              <dt>Type</dt>
              <dd>{request.type}</dd>
              <dt>Source</dt>
              <dd>{request.source}</dd>
              <dt>Environment</dt>
              <dd>{request.environmentId ?? 'unclassified'}</dd>
              <dt>Started</dt>
              <dd>{formatClock(request.timing.startedAt)}</dd>
              <dt>Duration</dt>
              <dd>
                {formatDuration(request.timing.durationMs)}
                {request.timing.injectedDelayMs ? ` (includes ${formatDuration(request.timing.injectedDelayMs)} injected delay)` : ''}
              </dd>
              <dt>Request size</dt>
              <dd>{formatBytes(request.requestBody?.byteLength ?? 0)}</dd>
              <dt>Response size</dt>
              <dd>{formatBytes(request.responseBody?.byteLength ?? 0)}</dd>
              <dt>Trace id</dt>
              <dd>{request.traceId ?? '—'}</dd>
              <dt>Span id</dt>
              <dd>{request.spanId ?? '—'}</dd>
              <dt>Parent span</dt>
              <dd>{request.parentSpanId ?? '—'}</dd>
              <dt>Correlation id</dt>
              <dd>{request.correlationId ?? '—'}</dd>
              <dt>Initiator</dt>
              <dd>{request.initiator ?? '—'}</dd>
              <dt>Page</dt>
              <dd>{request.pageUrl ?? '—'}</dd>
              {request.graphql ? (
                <>
                  <dt>GraphQL</dt>
                  <dd>
                    {request.graphql.operationType} {request.graphql.operationName ?? '(anonymous)'}
                  </dd>
                </>
              ) : null}
            </dl>

            {request.error ? (
              <div className="section" style={{ marginTop: 14 }}>
                <h3>Error</h3>
                <div className="error-text">{request.error}</div>
              </div>
            ) : null}

            {failure ? (
              <div className="section" style={{ marginTop: 14 }}>
                <h3>Failure analysis</h3>
                <div className="panelbox">
                  <div style={{ marginBottom: 6 }}>
                    <span className="label badge ok">Observed</span>
                  </div>
                  <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                    {failure.observed.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  {failure.possibleCauses.length > 0 ? (
                    <>
                      <div style={{ marginBottom: 6 }}>
                        <span className="label badge warn">Possible cause</span>
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
                        {failure.possibleCauses.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === 'request' ? (
          <>
            <div className="section">
              <h3>Query parameters</h3>
              {Object.keys(request.queryParams).length === 0 ? (
                <div className="muted">No query parameters.</div>
              ) : (
                <dl className="kv">
                  {Object.entries(request.queryParams).map(([name, value]) => (
                    <>
                      <dt key={`${name}-k`}>{name}</dt>
                      <dd key={`${name}-v`}>{value}</dd>
                    </>
                  ))}
                </dl>
              )}
            </div>
            <div className="section">
              <h3>Request headers</h3><p className="muted">Captured browser headers. Sensitive values are redacted before storage; hidden values cannot be recovered here.</p>
              <HeaderTable headers={request.requestHeaders} redacted={redactedRequestHeaders} />
            </div>
            <div className="section">
              <h3>Request body</h3>
              <JsonViewer body={request.requestBody} emptyLabel="This request had no body." />
            </div>
          </>
        ) : null}

        {tab === 'response' ? (
          <>
            <div className="section">
              <h3>Response headers</h3>
              <HeaderTable headers={request.responseHeaders} redacted={redactedResponseHeaders} />
            </div>
            <div className="section">
              <h3>Response body</h3>
              <JsonViewer
                body={request.responseBody}
                emptyLabel={
                  request.channel === 'browser-network'
                    ? 'Bodies are not available for browser-network observations. Enable page hooks or use the QA proxy to capture this payload.'
                    : 'No response body captured.'
                }
              />
            </div>
          </>
        ) : null}

        {tab === 'trace' ? (
          <>
            {request.traceId ? (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="badge accent">trace {request.traceId.slice(0, 12)}</span>
                  <button type="button" className="btn sm" onClick={() => onOpenTrace(request.traceId!)}>
                    Open in API Trace
                  </button>
                </div>
                <dl className="kv">
                  <dt>Span</dt>
                  <dd>{request.spanId ?? '—'}</dd>
                  <dt>Parent span</dt>
                  <dd>{request.parentSpanId ?? '—'}</dd>
                  <dt>Correlation</dt>
                  <dd>{request.correlationId ?? '—'}</dd>
                </dl>
              </>
            ) : (
              <div className="empty">
                <strong>No trace identity</strong>
                <span>
                  This request carried no <code>traceparent</code>, B3 or correlation header, so it cannot be linked to
                  server-side spans. Enable trace-header injection in Settings, or ask the backend team to propagate one.
                </span>
              </div>
            )}
          </>
        ) : null}

        {tab === 'checks' ? (
          <>
            <div className="section">
              <h3>Assertions</h3>
              {assertionResults.length === 0 ? (
                <div className="muted">No assertions apply to this endpoint.</div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Assertion</th>
                      <th>Result</th>
                      <th>Expected</th>
                      <th>Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assertionResults.map((result) => (
                      <tr key={result.assertionId}>
                        <td>{result.assertionName}</td>
                        <td className={result.passed ? 'ok-text' : 'error-text'}>{result.passed ? 'PASS' : 'FAIL'}</td>
                        <td className="mono">{result.expected}</td>
                        <td className="mono">{result.actual}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="section">
              <h3>Contract validation</h3>
              {schemaResult.skippedReason ? (
                <div className="muted">{schemaResult.skippedReason}</div>
              ) : schemaResult.valid ? (
                <div className="ok-text">Response matches the bound schema.</div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Violation</th>
                      <th>Path</th>
                      <th>Expected</th>
                      <th>Actual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schemaResult.violations.map((violation) => (
                      <tr key={`${violation.kind}-${violation.path}`}>
                        <td>{violation.kind}</td>
                        <td className="mono">{violation.path}</td>
                        <td className="mono">{violation.expected}</td>
                        <td className="mono">{violation.actual}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}

        {tab === 'code' ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <select className="select" value={codeTarget} onChange={(event) => setCodeTarget(event.target.value as typeof codeTarget)}>
                {CODE_TARGETS.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => void copy(code)}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void copy(JSON.stringify({ request: replay, response: request.responseBody?.content ?? null }, null, 2))}
              >
                Copy request JSON
              </button>
            </div>
            <pre className="raw">{code}</pre>
            <div className="muted" style={{ marginTop: 8 }}>
              Masked headers are omitted from generated code. Add a real credential before running it.
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
