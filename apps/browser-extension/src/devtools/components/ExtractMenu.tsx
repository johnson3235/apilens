import { useEffect, useRef, useState } from 'react';
import type { CapturedRequest } from '@apilens/shared-types';
import { EXTRACT_FORMATS, extract, type ExtractFormat } from '../../shared/request-export';
import { copyToClipboard, downloadFile } from '../hooks/bridge';

/**
 * Extracts the calls currently on screen.
 *
 * Always operates on the filtered list rather than the whole session, so what
 * the tester sees is exactly what lands in the defect report.
 */
export function ExtractMenu({
  requests,
  label,
  version,
  onNotice,
}: {
  requests: CapturedRequest[];
  label: string;
  version: string;
  onNotice: (message: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function run(format: ExtractFormat, mode: 'download' | 'copy'): void {
    if (requests.length === 0) {
      onNotice('Nothing to extract — no calls match the current filters.');
      setOpen(false);
      return;
    }
    const result = extract(requests, format, { version, label });
    if (mode === 'copy') {
      void copyToClipboard(result.content).then((ok) =>
        onNotice(ok ? `Copied ${requests.length} call(s) as ${format}.` : 'Clipboard access was blocked by the browser.'),
      );
    } else {
      downloadFile(result.filename, result.mime, result.content);
      onNotice(`Exported ${requests.length} call(s) to ${result.filename}.`);
    }
    setOpen(false);
  }

  return (
    <div className="extract-menu" ref={wrapRef}>
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        Extract<b>{requests.length}</b>
      </button>
      {open ? (
        <div className="extract-panel" role="menu" aria-label="Extract formats">
          <p className="muted">Exports the {requests.length} call(s) currently shown, with redaction already applied.</p>
          {EXTRACT_FORMATS.map((format) => (
            <div key={format.id} className="extract-row" role="none">
              <div>
                <strong>{format.label}</strong>
                <small>{format.hint}</small>
              </div>
              <div className="row">
                <button type="button" className="btn sm" role="menuitem" onClick={() => run(format.id, 'copy')}>Copy</button>
                <button type="button" className="btn sm" role="menuitem" onClick={() => run(format.id, 'download')}>Save</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
