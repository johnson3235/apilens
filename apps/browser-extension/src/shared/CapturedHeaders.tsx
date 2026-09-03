import { useState } from 'react';

export function CapturedHeaders({ requestHeaders, responseHeaders, scope = 'browser' }: { requestHeaders: Record<string, string>; responseHeaders: Record<string, string>; scope?: 'browser' | 'server' }): JSX.Element {
  const [filter, setFilter] = useState('');
  return <section className="captured-headers" aria-label="Captured headers">
    <h2>Headers</h2>
    <p>{scope === 'browser' ? 'Browser-visible headers only. Sensitive values stay redacted before storage and sharing. Missing headers are not evidence that the server omitted them; Fetch/XHR may expose only a subset.' : 'SDK-captured headers. Credential-like values are masked before telemetry leaves the server. Review application-specific personal data before sharing.'}</p>
    <label>Find a header<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="e.g. content-type or correlation" /></label>
    {([['Request headers', requestHeaders], ['Response headers', responseHeaders]] as const).map(([title, headers]) => {
      const entries = Object.entries(headers).filter(([name]) => name.toLowerCase().includes(filter.toLowerCase())).sort(([a], [b]) => a.localeCompare(b));
      return <section key={title}><h3>{title} ({Object.keys(headers).length})</h3>{entries.length ? <dl>{entries.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl> : <p>{Object.keys(headers).length ? 'No matching headers.' : 'No headers captured for this observation.'}</p>}</section>;
    })}
  </section>;
}
