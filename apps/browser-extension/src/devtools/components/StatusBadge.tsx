import React from 'react';

export default function StatusBadge({ status, source }: { status?: number; source?: string }) {
  let colorClass = 'gray';
  
  if (status) {
    if (status >= 200 && status < 300) colorClass = 'green';
    else if (status >= 300 && status < 400) colorClass = 'blue';
    else if (status >= 400 && status < 500) colorClass = 'yellow';
    else if (status >= 500) colorClass = 'red';
  }

  return (
    <span className={`status-badge status-${colorClass}`}>
      {status || 'ERR'}
    </span>
  );
}
