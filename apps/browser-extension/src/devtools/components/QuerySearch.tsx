import { useEffect, useRef, useState } from 'react';
import { QUERY_HELP, removeTerm, type ParsedQuery } from '../../shared/request-query';

/**
 * Search box with a discoverable query language.
 *
 * Plain words work immediately, so the box is never a barrier. The help panel
 * and the removable chips are what turn the advanced syntax into something a
 * tester can learn by using it rather than by reading documentation.
 */
export function QuerySearch({
  value,
  onChange,
  parsed,
  placeholder,
  shown,
  total,
  label = 'Filter captured calls',
}: {
  value: string;
  onChange: (value: string) => void;
  parsed: ParsedQuery;
  placeholder?: string;
  shown: number;
  total: number;
  label?: string;
}): JSX.Element {
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!helpOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setHelpOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setHelpOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [helpOpen]);

  // A global "/" focuses search, matching the muscle memory of DevTools.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="query-search" ref={wrapRef}>
      <div className="query-input">
        <span className="query-icon" aria-hidden="true">⌕</span>
        <label className="sr-only" htmlFor="apilens-query">{label}</label>
        <input
          id="apilens-query"
          ref={inputRef}
          className="input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value) {
              event.preventDefault();
              onChange('');
            }
          }}
          placeholder={placeholder ?? 'Search, or try status:5xx  method:POST  -image   (press / to focus)'}
          autoComplete="off"
          spellCheck={false}
        />
        {value ? (
          <button type="button" className="query-clear" aria-label="Clear the search box" onClick={() => onChange('')}>×</button>
        ) : null}
        <button
          type="button"
          className={`query-help-toggle ${helpOpen ? 'on' : ''}`}
          aria-expanded={helpOpen}
          aria-label="Search syntax help"
          title="Search syntax help"
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </button>
      </div>

      <div className="query-meta" aria-live="polite">
        <span className={shown === 0 && total > 0 ? 'warn-text' : 'muted'}>
          {total === 0 ? 'No calls captured yet' : `${shown} of ${total} shown`}
        </span>
        {parsed.terms.map((term) => (
          <button
            key={term.raw}
            type="button"
            className={`query-chip ${term.negate ? 'negated' : ''}`}
            title={`Remove ${term.raw}`}
            onClick={() => onChange(removeTerm(value, term.raw))}
          >
            {term.raw}<i aria-hidden="true">×</i>
          </button>
        ))}
      </div>

      {helpOpen ? (
        <div className="query-help" role="dialog" aria-label="Search syntax">
          <header>
            <strong>Search syntax</strong>
            <button type="button" className="btn sm" onClick={() => setHelpOpen(false)}>Close</button>
          </header>
          <p className="muted">Words are combined with AND. Click an example to insert it.</p>
          <ul>
            {QUERY_HELP.map((entry) => (
              <li key={entry.example}>
                <button type="button" onClick={() => { onChange(`${value} ${entry.example}`.trim()); inputRef.current?.focus(); }}>
                  <code>{entry.example}</code>
                </button>
                <span>{entry.meaning}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
