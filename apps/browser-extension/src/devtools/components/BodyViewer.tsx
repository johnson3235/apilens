import { useMemo, useState } from 'react';
import type { ServerCapturedBody } from '../../shared/server-control';

interface BodyViewerProps {
  body: ServerCapturedBody | null;
  omitted: string | null;
  label: string;
  /** Explains a null body when the SDK gave no specific reason. */
  emptyHint?: string;
  onCopy?: (value: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function highlight(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) return /:$/.test(match) ? `<span class="k">${match}</span>` : `<span class="s">${match}</span>`;
        if (/true|false/.test(match)) return `<span class="b">${match}</span>`;
        if (/null/.test(match)) return `<span class="z">${match}</span>`;
        return `<span class="n">${match}</span>`;
      },
    );
}

function decode(body: ServerCapturedBody): string {
  if (body.encoding !== 'base64') return body.content;
  try {
    return atob(body.content);
  } catch {
    return body.content;
  }
}

/**
 * Renders a captured server payload.
 *
 * Being explicit about truncation, redaction and *why* something is missing is
 * the whole point: a silently blank panel is indistinguishable from a bug, and
 * testers stop trusting the tool the first time it happens.
 */
export function BodyViewer({ body, omitted, label, emptyHint, onCopy }: BodyViewerProps): JSX.Element {
  const [raw, setRaw] = useState(false);
  const [filter, setFilter] = useState('');

  const text = useMemo(() => (body ? decode(body) : ''), [body]);

  const pretty = useMemo(() => {
    if (!text || raw) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }, [text, raw]);

  const shown = pretty ?? text;
  const lines = useMemo(() => {
    if (!filter.trim()) return null;
    const needle = filter.toLowerCase();
    return shown.split('\n').filter((line) => line.toLowerCase().includes(needle));
  }, [shown, filter]);

  if (!body) {
    return (
      <div className="body-empty">
        <strong>{label}</strong>
        <p>{omitted ?? emptyHint ?? 'No payload was captured for this call.'}</p>
      </div>
    );
  }

  const display = lines ? lines.join('\n') : shown;

  return (
    <div className="body-viewer">
      <div className="body-toolbar">
        <span className="badge">{body.contentType ?? 'unknown type'}</span>
        <span className="badge">{formatBytes(body.byteLength)}</span>
        {body.truncated ? <span className="badge warn" title="Increase captureBodies.maxBytes on the server to see more">truncated</span> : null}
        {body.redacted ? <span className="badge mock" title="Sensitive values were removed on the server before capture">redacted</span> : null}
        {body.encoding === 'base64' ? <span className="badge">base64</span> : null}
        <span className="spacer" />
        <label className="body-filter">
          <span className="sr-only">Filter payload lines</span>
          <input className="input xs" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter lines…" />
        </label>
        <button type="button" className="btn sm" onClick={() => setRaw((value) => !value)} disabled={pretty === null && !raw}>
          {raw ? 'Pretty' : 'Raw'}
        </button>
        <button type="button" className="btn sm" onClick={() => onCopy?.(text)}>Copy</button>
      </div>

      {lines && lines.length === 0 ? (
        <div className="muted pad-sm">No lines match “{filter}”.</div>
      ) : pretty !== null && !raw ? (
        <pre className="raw json" tabIndex={0} dangerouslySetInnerHTML={{ __html: highlight(display) }} />
      ) : (
        <pre className="raw" tabIndex={0}>{display}</pre>
      )}
    </div>
  );
}
