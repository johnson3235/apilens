import type { CapturedRequest, CaptureChannel } from '@apilens/shared-types';

export function StatusBadge({ request }: { request: CapturedRequest }): JSX.Element {
  if (request.error) return <span className="badge err">ERR</span>;
  if (request.statusCode === null) return <span className="badge">pending</span>;
  const bucket = Math.floor(request.statusCode / 100);
  const tone = bucket >= 5 ? 'err' : bucket === 4 ? 'warn' : bucket === 3 ? 'accent' : 'ok';
  return <span className={`badge ${tone}`}>{request.statusCode}</span>;
}

const CHANNEL_LABELS: Record<CaptureChannel, { label: string; tone: string; title: string }> = {
  'page-hook': { label: 'page', tone: '', title: 'Observed in the page via patched fetch/XHR.' },
  'browser-network': { label: 'browser', tone: '', title: 'Observed by the browser network stack (no body available).' },
  'browser-mock': { label: 'mocked', tone: 'mock', title: 'Response was produced by an ApiLens rule in the browser.' },
  'server-sdk': { label: 'server', tone: 'server', title: 'Reported by an instrumented backend through the QA agent.' },
  'qa-proxy': { label: 'proxy', tone: 'server', title: 'Observed by the QA reverse proxy in front of a backend service.' },
  replay: { label: 'replay', tone: 'accent', title: 'Produced by a manual replay.' },
  imported: { label: 'imported', tone: '', title: 'Imported from a file.' },
};

/**
 * Makes the *provenance* of every row explicit.
 *
 * This is the honesty guarantee of the product: a QA engineer can always see
 * whether a row was observed in the browser, reported by an instrumented
 * backend, or captured by the QA proxy.
 */
export function ChannelBadge({ channel }: { channel: CaptureChannel }): JSX.Element {
  const meta = CHANNEL_LABELS[channel];
  return (
    <span className={`badge ${meta.tone}`} title={meta.title}>
      {meta.label}
    </span>
  );
}

export function MethodLabel({ method }: { method: string }): JSX.Element {
  const tone = method === 'GET' ? 'muted' : method === 'DELETE' ? 'error-text' : 'ok-text';
  return <span className={tone}>{method}</span>;
}
