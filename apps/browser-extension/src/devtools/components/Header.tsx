import React from 'react';

export default function Header() {
  return (
    <div className="apilens-header">
      <div className="apilens-logo">ApiLens</div>
      <div className="apilens-status-indicator recording">Recording</div>
      <div className="apilens-header-actions">
        <button className="btn btn-sm">Clear</button>
        <button className="btn btn-sm">Export HAR</button>
        <button className="btn btn-icon">⚙️</button>
      </div>
    </div>
  );
}
