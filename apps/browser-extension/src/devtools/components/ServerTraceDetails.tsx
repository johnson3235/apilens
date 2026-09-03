import type { TraceNode, TraceTree } from '@apilens/shared-types';
import { CapturedHeaders } from '../../shared/CapturedHeaders';

function headers(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

function SpanDetails({ node }: { node: TraceNode }): JSX.Element {
  const span = node.span;
  return <li><details><summary><strong>{span.method ?? span.kind} {span.url ?? span.operationName}</strong> · {span.serviceName} · {span.kind} · {span.statusCode ?? span.status} · {Math.round(span.durationMs)} ms</summary>
    <p>{span.channel} · {span.kind === 'client' ? 'Outbound call from this service' : 'Incoming or internal span'}{node.orphaned ? ' · Parent span not captured' : ''}</p>
    {span.error ? <p role="status">{span.error}</p> : null}
    <p>Timing: {String(span.attributes.timingScope ?? 'captured span')}. Response bodies are not captured by the Next SDK.</p>
    <CapturedHeaders scope={span.channel === 'server-sdk' ? 'server' : 'browser'} requestHeaders={headers(span.attributes.requestHeaders)} responseHeaders={headers(span.attributes.responseHeaders)} />
  </details>{node.children.length ? <ul>{node.children.map((child) => <SpanDetails key={child.span.spanId} node={child} />)}</ul> : null}</li>;
}

export function ServerTraceDetails({ trace }: { trace: TraceTree }): JSX.Element {
  return <section aria-label="Trace calls"><p>{trace.services.join(' → ')} · {trace.hasGaps ? 'Some parent spans are missing' : 'Captured parent links resolved'}</p><ul className="server-trace-list">{trace.roots.map((node) => <SpanDetails key={node.span.spanId} node={node} />)}</ul></section>;
}
