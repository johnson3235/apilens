import React from 'react';
import { CapturedRequest } from '@apilens/shared-types';

interface RequestListProps {
  requests: CapturedRequest[];
  clearRequests: () => void;
  requestCount: number;
  onCreateRule?: (request: CapturedRequest) => void;
  onSelectRequest?: (request: CapturedRequest) => void;
  selectedRequestId?: string | null;
}

const getSourceIcon = (source: string) => {
  switch(source) {
    case 'browser': return '🌐';
    case 'frontend-server': return '🖥️';
    case 'bff': return '🔀';
    case 'gateway': return '🚪';
    default: return '📄';
  }
};

const getStatusColor = (status?: number) => {
  if (!status) return 'status-gray';
  if (status >= 200 && status < 300) return 'status-green';
  if (status >= 300 && status < 400) return 'status-blue';
  if (status >= 400 && status < 500) return 'status-yellow';
  return 'status-red';
};

export const RequestList: React.FC<RequestListProps> = ({ 
  requests, 
  clearRequests, 
  requestCount, 
  onCreateRule,
  onSelectRequest,
  selectedRequestId
}) => {
  return (
    <div className="request-list-pane">
      {requests.length === 0 ? (
        <div className="empty-state">
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>📡</div>
          <div>No API requests captured matching current filters.</div>
          <div style={{ fontSize: '11px', marginTop: '6px', color: 'var(--text-muted)' }}>
            Trigger API activity on the webpage to inspect network traffic live.
          </div>
        </div>
      ) : (
        <table className="request-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>Src</th>
              <th style={{ width: '70px' }}>Method</th>
              <th style={{ width: '70px' }}>Status</th>
              <th>Path / URL</th>
              <th style={{ width: '80px' }}>Duration</th>
              <th style={{ width: '80px' }}>Type</th>
              <th style={{ width: '90px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(req => (
              <tr 
                key={req.id} 
                className={`request-row ${req.id === selectedRequestId ? 'selected' : ''} ${req.error ? 'error-row' : ''} ${req.scenarioApplied ? 'mocked-row' : ''}`}
                onClick={() => onSelectRequest && onSelectRequest(req)}
              >
                <td className="source-icon" title={req.source}>{getSourceIcon(req.source)}</td>
                <td className={`method-${req.method.toLowerCase()}`}>{req.method}</td>
                <td><span className={`status-badge ${getStatusColor(req.statusCode)}`}>{req.error ? 'ERR' : req.statusCode || '-'}</span></td>
                <td title={req.url} style={{ fontFamily: 'monospace' }}>{req.path || req.url}</td>
                <td>{req.durationMs ? `${req.durationMs}ms` : '-'}</td>
                <td><span className="tag">{req.type}</span></td>
                <td>
                  {onCreateRule && (
                    <button 
                      className="btn btn-sm"
                      style={{ fontSize: '10px', padding: '1px 6px' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateRule(req);
                      }}
                      title="Create mock rule from request"
                    >
                      ⚡ Mock
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
