import type { CaptureDiagnosis } from '../../shared/server-diagnosis';
import { Icon } from './Icon';

const STATE_GLYPH = { ok: '✓', warn: '!', fail: '✕', info: 'i' } as const;

/** The server's own account of what it captured and what it skipped, with the fix to hand over. */
export function CaptureDiagnosisCard({
  diagnosis,
  onCopy,
  onRefresh,
  onClose,
  onOpenBrowserCalls,
}: {
  diagnosis: CaptureDiagnosis;
  onCopy: (value: string) => void;
  onRefresh?: () => void;
  onClose?: () => void;
  onOpenBrowserCalls?: () => void;
}): JSX.Element {
  const icon = diagnosis.tone === 'ok' ? 'check' : diagnosis.tone === 'info' ? 'info' : 'alert';
  return (
    <section className={`diag ${diagnosis.tone}`} aria-labelledby="diag-title">
      <header className="diag-head">
        <span className="badge-icon"><Icon name={icon} size={18} /></span>
        <div>
          <h2 id="diag-title">{diagnosis.headline}</h2>
          <p>{diagnosis.tone === 'ok' ? 'Connected. Open or reload a page in the app; its server calls appear here within a couple of seconds.' : 'What the server reports about the requests it saw. Copy the fix for the app’s developer.'}</p>
        </div>
        <div className="actions">
          {onRefresh ? <button className="btn sm" onClick={onRefresh}><Icon name="refresh" size={13} />Check again</button> : null}
          {onClose ? <button className="icon-btn" onClick={onClose} aria-label="Hide the diagnosis"><Icon name="close" /></button> : null}
        </div>
      </header>
      <ul className="diag-list">
        {diagnosis.checks.map((check) => (
          <li key={check.id} data-check={check.id}>
            <span className={`state ${check.state}`} aria-label={check.state}>{STATE_GLYPH[check.state]}</span>
            <strong>{check.title}</strong>
            <p>
              {check.detail}
              {check.id === 'backend' && onOpenBrowserCalls ? <> <button className="btn ghost sm" onClick={onOpenBrowserCalls}>Open Browser calls</button></> : null}
            </p>
            {check.fix ? (
              <div className="fix">
                <pre>{check.fix}</pre>
                <button className="btn sm" onClick={() => onCopy(check.fix!)}><Icon name="copy" size={12} />Copy</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
