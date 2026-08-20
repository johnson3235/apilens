import React, { useState } from 'react';
import { CapturedRequest } from '@apilens/shared-types';

interface RequestDetailProps {
  request: CapturedRequest;
  onClose: () => void;
  onCreateRule?: (request: CapturedRequest) => void;
}

export const RequestDetail: React.FC<RequestDetailProps> = ({ request, onClose, onCreateRule }) => {
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'actions'>('request');

  const copyCurl = () => {
    let curl = `curl -X ${request.method} '${request.url}'`;
    Object.entries(request.requestHeaders || {}).forEach(([k, v]) => {
      curl += ` \\\n  -H '${k}: ${v}'`;
    });
    if (request.requestBody) {
      curl += ` \\\n  -d '${request.requestBody.replace(/'/g, "'\\''")}'`;
    }
    navigator.clipboard.writeText(curl);
    alert('Copied cURL to clipboard!');
  };

  const exportHar = () => {
    const har = {
      log: {
        version: "1.2",
        creator: { name: "ApiLens", version: "0.3.0" },
        entries: [{
          startedDateTime: new Date(request.startedAt).toISOString(),
          time: request.durationMs || 0,
          request: {
            method: request.method,
            url: request.url,
            httpVersion: "HTTP/1.1",
            headers: Object.entries(request.requestHeaders || {}).map(([name, value]) => ({ name, value })),
            queryString: Object.entries(request.queryParams || {}).map(([name, value]) => ({ name, value })),
            postData: request.requestBody ? { mimeType: "application/json", text: request.requestBody } : undefined
          },
          response: {
            status: request.statusCode || 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: Object.entries(request.responseHeaders || {}).map(([name, value]) => ({ name, value })),
            content: { mimeType: "application/json", text: request.responseBody }
          },
          cache: {},
          timings: { send: 0, wait: request.durationMs || 0, receive: 0 },
          _apilens: {
            mocked: Boolean(request.scenarioApplied),
            rule: request.scenarioApplied,
            source: request.source,
            clientSide: request.isClientSide
          }
        }]
      }
    };
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `request-${request.id}.har`;
    a.click();
  };

  return (
    <div className="request-detail-pane">
      <div className="detail-header">
        <h4>Request Details</h4>
        <button className="btn-icon" onClick={onClose}>×</button>
      </div>
      
      {request.scenarioApplied && (
        <div style={{ padding: 12 }}>
          <div className="scenario-banner">
            <strong>⚡ MOCKED FROM APILENS</strong><br />
            Rule: {request.scenarioApplied}
          </div>
        </div>
      )}

      <div className="detail-tabs">
        <button className={`detail-tab-btn ${activeTab === 'request' ? 'active' : ''}`} onClick={() => setActiveTab('request')}>Request</button>
        <button className={`detail-tab-btn ${activeTab === 'response' ? 'active' : ''}`} onClick={() => setActiveTab('response')}>Response</button>
        <button className={`detail-tab-btn ${activeTab === 'actions' ? 'active' : ''}`} onClick={() => setActiveTab('actions')}>Actions</button>
      </div>

      <div className="detail-content">
        {activeTab === 'request' && (
          <>
            <div className="detail-section">
              <h5>General</h5>
              <div className="key-value"><div className="key">URL</div><div className="value">{request.url}</div></div>
              <div className="key-value"><div className="key">Method</div><div className="value"><span className={`method-${request.method.toLowerCase()}`}>{request.method}</span></div></div>
              <div className="key-value"><div className="key">Source</div><div className="value">{request.isClientSide ? 'Client-side' : 'Server-side'} ({request.source})</div></div>
              {request.traceId && <div className="key-value"><div className="key">Trace ID</div><div className="value">{request.traceId}</div></div>}
            </div>
            
            <div className="detail-section">
              <h5>Headers</h5>
              {Object.entries(request.requestHeaders || {}).length > 0 ? (
                Object.entries(request.requestHeaders || {}).map(([k, v]) => (
                  <div key={k} className="key-value"><div className="key">{k}</div><div className="value">{v}</div></div>
                ))
              ) : <div style={{ color: 'var(--text-muted)' }}>No headers</div>}
            </div>

            <div className="detail-section">
              <h5>Body</h5>
              {request.requestBody ? (
                <pre>{request.requestBody}</pre>
              ) : <div style={{ color: 'var(--text-muted)' }}>No body</div>}
            </div>
          </>
        )}

        {activeTab === 'response' && (
          <>
            <div className="detail-section">
              <h5>General</h5>
              <div className="key-value"><div className="key">Status</div><div className="value"><span className={`status-badge status-${request.statusCode && request.statusCode < 400 ? 'green' : 'red'}`}>{request.statusCode || '-'}</span></div></div>
              <div className="key-value"><div className="key">Duration</div><div className="value">{request.durationMs ? `${request.durationMs}ms` : '-'}</div></div>
              {request.scenarioApplied && <div className="key-value"><div className="key">Delivery</div><div className="value">Synthetic response returned directly to the application</div></div>}
              {request.responseHeaders?.['x-apilens-transport'] && <div className="key-value"><div className="key">Interceptor</div><div className="value">{request.responseHeaders['x-apilens-transport']}</div></div>}
              {request.responseHeaders?.['x-apilens-original-status'] && <div className="key-value"><div className="key">Original Status</div><div className="value">{request.responseHeaders['x-apilens-original-status']}</div></div>}
            </div>

            <div className="detail-section">
              <h5>Headers</h5>
              {Object.entries(request.responseHeaders || {}).length > 0 ? (
                Object.entries(request.responseHeaders || {}).map(([k, v]) => (
                  <div key={k} className="key-value"><div className="key">{k}</div><div className="value">{v}</div></div>
                ))
              ) : <div style={{ color: 'var(--text-muted)' }}>No headers</div>}
            </div>

            <div className="detail-section">
              <h5>Body</h5>
              {request.responseBody ? (
                <pre>{request.responseBody}</pre>
              ) : <div style={{ color: 'var(--text-muted)' }}>No body captured</div>}
            </div>
          </>
        )}

        {activeTab === 'actions' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {onCreateRule && (
              <button className="btn btn-primary" onClick={() => onCreateRule(request)}>
                Create Rule from Request
              </button>
            )}
            <button className="btn" onClick={copyCurl}>Copy as cURL</button>
            <button className="btn" onClick={exportHar}>Export as HAR</button>
          </div>
        )}
      </div>
    </div>
  );
};
