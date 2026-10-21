import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerBridgeStatus, ServerCall, ServerMockRule } from '../../shared/server-control';
import type { ServerControlSettings } from '../../shared/settings';
import { send } from './bridge';

export interface ServerData {
  calls: ServerCall[];
  status: ServerBridgeStatus | null;
  rules: ServerMockRule[];
  /** Populated only when a sync fails; successful polls clear it. */
  error: string | null;
  syncing: boolean;
  refresh: () => Promise<void>;
  clear: () => Promise<void>;
  saveRules: (rules: ServerMockRule[]) => Promise<void>;
}

const MAX_CALLS = 5_000;

/**
 * Keeps the panel in step with the instrumented server.
 *
 * The panel drives the poll rather than the service worker: an MV3 worker is
 * evicted after ~30s of inactivity, so a worker-owned timer would silently
 * stop. Polling from this long-lived page keeps the worker awake exactly while
 * a tester is watching.
 */
export function useServerData(settings: ServerControlSettings | undefined): ServerData {
  const [calls, setCalls] = useState<ServerCall[]>([]);
  const [status, setStatus] = useState<ServerBridgeStatus | null>(null);
  const [rules, setRules] = useState<ServerMockRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const configured = Boolean(settings?.enabled && settings.url && settings.token);
  const interval = Math.max(1_000, settings?.pollIntervalMs ?? 2_000);

  const merge = useCallback((incoming: ServerCall[]) => {
    if (incoming.length === 0) return;
    setCalls((previous) => {
      const merged = new Map(previous.map((call) => [call.spanId, call]));
      incoming.forEach((call) => merged.set(call.spanId, call));
      const list = [...merged.values()].sort((left, right) => left.startedAt - right.startedAt || left.seq - right.seq);
      return list.length > MAX_CALLS ? list.slice(-MAX_CALLS) : list;
    });
  }, []);

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const snapshot = await send<{ ok: true; serverStatus: ServerBridgeStatus; calls: ServerCall[] }>({ type: 'server:calls:get' });
      setStatus(snapshot.serverStatus);
      setCalls(snapshot.calls);
      const stored = await send<{ ok: true; serverRules: ServerMockRule[] }>({ type: 'server:rules:get' });
      setRules(stored.serverRules);
      setError(snapshot.serverStatus.error);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSyncing(false);
    }
  }, []);

  const clear = useCallback(async () => {
    await send({ type: 'server:calls:clear' });
    setCalls([]);
  }, []);

  const saveRules = useCallback(async (next: ServerMockRule[]) => {
    const result = await send<{ ok: true; serverRules: ServerMockRule[] }>({ type: 'server:rules:set', rules: next });
    setRules(result.serverRules);
  }, []);

  useEffect(() => {
    stopped.current = false;
    if (!configured) {
      setStatus((previous) => (previous ? { ...previous, configured: false, connected: false } : previous));
      return () => {
        stopped.current = true;
      };
    }

    void refresh();

    const tick = async (): Promise<void> => {
      if (stopped.current) return;
      try {
        const result = await send<{ ok: true; serverStatus: ServerBridgeStatus; calls: ServerCall[] }>({ type: 'server:sync' });
        if (stopped.current) return;
        setStatus(result.serverStatus);
        setError(result.serverStatus.error);
        merge(result.calls);
      } catch (caught) {
        if (!stopped.current) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        // Chained timeout, not an interval: a slow or failing server can never
        // build a backlog of overlapping polls.
        if (!stopped.current) timer.current = setTimeout(() => void tick(), interval);
      }
    };

    timer.current = setTimeout(() => void tick(), interval);
    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [configured, interval, merge, refresh]);

  // Rule counters change on the server as mocks fire; keep the UI honest.
  useEffect(() => {
    if (!status?.connected) return;
    let cancelled = false;
    void send<{ ok: true; serverRules: ServerMockRule[] }>({ type: 'server:rules:get' })
      .then((result) => {
        if (!cancelled) setRules(result.serverRules);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status?.connected, status?.health?.ruleCount, status?.lastSyncAt]);

  return { calls, status, rules, error, syncing, refresh, clear, saveRules };
}
