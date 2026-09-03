import { createSpanId, createTraceId } from '@apilens/core';

export interface TracePropagationSettings {
  enabled: boolean;
  sessionId: string | null;
  scenarioId: string | null;
  origin: string | null;
}

/** Never attach QA context to unrelated pages, cross-origin APIs or inactive sessions. */
export function traceHeadersFor(headers: Record<string, string>, url: string, pageOrigin: string, settings: TracePropagationSettings): Record<string, string> {
  if (!settings.enabled || !settings.sessionId || settings.origin !== pageOrigin) return headers;
  try { if (new URL(url, pageOrigin).origin !== pageOrigin) return headers; } catch { return headers; }
  return { ...headers, traceparent: headers.traceparent ?? `00-${createTraceId()}-${createSpanId()}-01`,
    'x-qa-session-id': settings.sessionId,
    ...(settings.scenarioId ? { 'x-test-scenario-id': settings.scenarioId } : {}),
  };
}
