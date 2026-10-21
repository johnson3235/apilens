'use client';

import type { ReactNode } from 'react';
import type { ApiState } from '@/lib/use-api';

/** A card that shows loading, a friendly error with Retry, or its content. */
export function Section<T>({
  title,
  state,
  onRetry,
  testId,
  children,
}: {
  title: string;
  state: ApiState<T>;
  onRetry: () => void;
  testId: string;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className="card" data-testid={testId} aria-busy={state.status === 'loading'}>
      <h2 className="card-title">{title}</h2>
      {state.status === 'loading' ? (
        <div className="loading" role="status">
          <div className="skeleton wide" />
          <div className="skeleton" />
          {state.slow ? <p className="muted">Still loading… this is taking longer than usual.</p> : null}
        </div>
      ) : state.status === 'error' ? (
        <div className="error-box" role="alert">
          <p><strong>We couldn’t load this right now.</strong></p>
          <p className="muted">{state.message}</p>
          <div className="row">
            <button className="btn secondary" onClick={onRetry}>Try again</button>
            <span className="tech">{state.httpStatus ? `HTTP ${state.httpStatus}` : 'No response'}</span>
          </div>
        </div>
      ) : (
        children(state.data)
      )}
    </section>
  );
}
