import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CapturedRequest, TraceSpan, TraceTree } from '@apilens/shared-types';
import { buildTraceTrees, correlate } from '@apilens/trace-engine';
import type { PanelState } from '../../shared/messages';
import { fetchState, inspectedTabId, send, subscribe } from './bridge';

export interface PanelData {
  state: PanelState | null;
  requests: CapturedRequest[];
  spans: TraceSpan[];
  traces: TraceTree[];
  requestIdBySpanId: Map<string, string>;
  consoleMessages: Array<{ level: 'error' | 'warning' | 'info'; text: string; timestamp: number; url: string | null }>;
  error: string | null;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
  setState: (state: PanelState) => void;
}

const MAX_LIVE = 8_000;

/**
 * Single source of truth for the panel.
 *
 * Incoming captures are buffered and applied on an animation frame so a burst
 * of hundreds of requests produces one React render rather than hundreds.
 */
export function usePanelData(): PanelData {
  const [state, setState] = useState<PanelState | null>(null);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [consoleMessages, setConsoleMessages] = useState<PanelData['consoleMessages']>([]);
  const [error, setError] = useState<string | null>(null);

  const requestBuffer = useRef<CapturedRequest[]>([]);
  const spanBuffer = useRef<TraceSpan[]>([]);
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    frame.current = null;

    if (requestBuffer.current.length > 0) {
      const incoming = requestBuffer.current;
      requestBuffer.current = [];
      setRequests((previous) => {
        const merged = new Map(previous.map((request) => [request.id, request]));
        incoming.forEach((request) => merged.set(request.id, request));
        const list = [...merged.values()];
        return list.length > MAX_LIVE ? list.slice(-MAX_LIVE) : list;
      });
    }

    if (spanBuffer.current.length > 0) {
      const incoming = spanBuffer.current;
      spanBuffer.current = [];
      setSpans((previous) => {
        const merged = new Map(previous.map((span) => [span.spanId, span]));
        incoming.forEach((span) => merged.set(span.spanId, span));
        return [...merged.values()];
      });
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(flush);
  }, [flush]);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState();
      setState(next);
      const sessionId = next.session?.id ?? null;
      const [requestResult, spanResult] = await Promise.all([
        send<{ ok: true; requests: CapturedRequest[] }>({ type: 'requests:get', tabId: inspectedTabId(), sessionId }),
        send<{ ok: true; spans: TraceSpan[] }>({ type: 'spans:get', sessionId }),
      ]);
      setRequests(requestResult.requests);
      setSpans(spanResult.spans);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const clear = useCallback(async () => {
    await send({ type: 'requests:clear', tabId: inspectedTabId() });
    setRequests([]);
    setSpans([]);
    setConsoleMessages([]);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'event:requests':
          requestBuffer.current.push(...event.requests);
          scheduleFlush();
          return;
        case 'event:spans':
          spanBuffer.current.push(...event.spans);
          scheduleFlush();
          return;
        case 'event:state':
          setState(event.state);
          return;
        case 'event:agent':
          setState((previous) => (previous ? { ...previous, agent: event.agent } : previous));
          return;
        case 'event:console':
          setConsoleMessages((previous) =>
            [...previous, { level: event.level, text: event.text, timestamp: event.timestamp, url: null }].slice(-200),
          );
          return;
        default:
          return;
      }
    });

    return () => {
      unsubscribe();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [refresh, scheduleFlush]);

  const correlation = useMemo(() => correlate(requests, spans, state?.settings.traceHeaders), [requests, spans, state?.settings.traceHeaders]);

  const traces = useMemo(
    () => buildTraceTrees(correlation.spans, { requestIdBySpanId: correlation.requestIdBySpanId }),
    [correlation],
  );

  return {
    state,
    requests,
    spans: correlation.spans,
    traces,
    requestIdBySpanId: correlation.requestIdBySpanId,
    consoleMessages,
    error,
    refresh,
    clear,
    setState,
  };
}
