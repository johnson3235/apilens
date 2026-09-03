import { useMemo, useState } from 'react';
import type { CapturedBody } from '@apilens/shared-types';
import { formatBytes } from '@apilens/core';

interface JsonViewerProps {
  body: CapturedBody | null;
  /** Fallback label when there is nothing to show. */
  emptyLabel?: string;
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

/**
 * Renders a payload with syntax highlighting, and is explicit about *why*
 * content is missing — truncated, binary or simply not captured. Silent blanks
 * are the enemy of trust in a debugging tool.
 */
export function JsonViewer({ body, emptyLabel = 'No body captured.' }: JsonViewerProps): JSX.Element {
  const [raw, setRaw] = useState(false);

  const rendered = useMemo(() => {
    if (!body?.content) return null;
    if (raw) return null;
    try {
      return JSON.stringify(JSON.parse(body.content), null, 2);
    } catch {
      return null;
    }
  }, [body, raw]);

  if (!body || body.content === null) {
    return <div className="muted">{body?.omittedReason ?? emptyLabel}</div>;
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="badge">{body.mimeType ?? 'unknown type'}</span>
        <span className="badge">{formatBytes(body.byteLength)}</span>
        {body.encoding === 'truncated' ? <span className="badge warn">truncated</span> : null}
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => setRaw((value) => !value)}>
          {raw ? 'Pretty' : 'Raw'}
        </button>
      </div>

      {body.omittedReason ? <div className="warn-text" style={{ marginBottom: 6 }}>{body.omittedReason}</div> : null}

      {rendered !== null ? (
        <pre className="raw json" dangerouslySetInnerHTML={{ __html: highlight(rendered) }} />
      ) : (
        <pre className="raw">{body.content}</pre>
      )}
    </div>
  );
}
