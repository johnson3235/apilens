import React from 'react';
import { CapturedRequest, TraceSpan, TimelineEntry } from '@apilens/shared-types';

interface TimelineProps {
  requests: CapturedRequest[];
  traces?: TraceSpan[];
}

const getSourceIcon = (source: string) => {
  switch(source) {
    case 'browser': return '🌐';
    case 'frontend-server': return '🖥️';
    case 'bff': return '🔀';
    case 'gateway': return '🚪';
    case 'internal-service': return '⚙️';
    case 'database': return '🗄️';
    default: return '📄';
  }
};

export const Timeline: React.FC<TimelineProps> = ({ requests, traces = [] }) => {
  // Generate basic timeline from requests if no traces
  const entries: TimelineEntry[] = requests.map(r => ({
    id: r.id,
    type: 'request',
    source: r.source as any,
    serviceName: r.serviceName || 'browser',
    operation: r.path,
    method: r.method,
    url: r.url,
    statusCode: r.statusCode,
    durationMs: r.durationMs || 0,
    startedAt: r.startedAt,
    endedAt: r.completedAt || r.startedAt,
    depth: 0,
    isClientSide: r.isClientSide,
    scenarioApplied: r.scenarioApplied
  })).sort((a, b) => a.startedAt - b.startedAt);

  if (entries.length === 0) {
    return <div className="empty-state">No timeline data available</div>;
  }

  const sessionStart = entries[0].startedAt;
  const sessionEnd = Math.max(...entries.map(e => e.endedAt || e.startedAt));
  const sessionDuration = sessionEnd - sessionStart || 1;

  return (
    <div className="timeline-container">
      <div style={{ marginBottom: 16 }}>
        <strong>Total Duration: {sessionDuration}ms</strong>
      </div>
      {entries.map(e => {
        const left = ((e.startedAt - sessionStart) / sessionDuration) * 100;
        const width = Math.max((e.durationMs / sessionDuration) * 100, 1);
        
        return (
          <div key={e.id} className="timeline-entry">
            <div className="time-label">+{e.startedAt - sessionStart}ms</div>
            <div style={{ paddingLeft: e.depth * 16 }} className="timeline-indent">
              <span className="source-icon" style={{ marginRight: 8 }}>{getSourceIcon(e.source)}</span>
            </div>
            <div className="method-label" style={{ color: `var(--accent-blue)` }}>{e.method}</div>
            <div className="path-label">{e.operation}</div>
            
            <div className="waterfall-container">
              <div 
                className="waterfall-bar" 
                style={{ 
                  position: 'absolute', 
                  left: `${left}%`, 
                  width: `${width}%`,
                  background: `var(--accent-blue)`
                }} 
              />
            </div>
            <div className="duration-label">{e.durationMs}ms</div>
          </div>
        );
      })}
    </div>
  );
};
