import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { AgentCapabilities } from '@apilens/shared-types';
import { AGENT_VERSION, type AgentConfig } from './config';
import { SessionStore } from './store';
import { AgentHub } from './hub';
import { EvidenceWriter } from './evidence-writer';
import { createHttpApi } from './http-api';
import { MockProxy } from './mock-proxy';

export interface AgentHandle {
  store: SessionStore;
  hub: AgentHub;
  port: number;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Boots the QA local agent.
 *
 * Binding is restricted to loopback unless the operator sets
 * `APILENS_ALLOW_REMOTE=1`, which is logged loudly — an agent reachable from
 * the network would expose captured traffic to anyone on it.
 */
export async function startAgent(
  config: AgentConfig,
  log: (message: string) => void = (message) => console.log(message),
): Promise<AgentHandle> {
  if (!LOOPBACK_HOSTS.has(config.host) && process.env.APILENS_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to bind ApiLens agent to non-loopback host "${config.host}". Set APILENS_ALLOW_REMOTE=1 only if you fully understand the exposure.`,
    );
  }

  const store = new SessionStore({
    maxSessions: config.maxSessions,
    maxRequestsPerSession: config.maxRequestsPerSession,
    maxSpansPerSession: config.maxSpansPerSession,
    autoDeleteAfterDays: config.autoDeleteAfterDays,
  });

  const evidenceWriter = new EvidenceWriter(store, config.outputDir);

  const capabilities: AgentCapabilities = {
    traceAggregation: true,
    serverSpanIngest: true,
    mockProxy: config.proxyRoutes.length > 0,
    replay: true,
    evidenceExport: true,
    proxyRoutes: config.proxyRoutes.map((route) => ({ id: route.id, listenPort: route.listenPort, target: route.target })),
  };

  const hub = new AgentHub({ token: config.token, store, evidenceWriter, capabilities, log });
  const handler = createHttpApi({ token: config.token, store, hub, evidenceWriter });

  const server: Server = createServer((message, response) => {
    void handler(message, response);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  hub.attach(wss);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const boundPort = (server.address() as AddressInfo).port;

  const proxies: MockProxy[] = [];
  for (const route of config.proxyRoutes) {
    const proxy = new MockProxy(route, store, {
      onRequest: (sessionId, request) => hub.broadcastRequests(sessionId, [request]),
      onSpan: (sessionId, span) => hub.broadcastSpans(sessionId, [span]),
      log,
    });
    try {
      await proxy.start();
      proxies.push(proxy);
      log(`QA proxy ${route.id} listening on http://127.0.0.1:${route.listenPort} → ${route.target}`);
    } catch (error) {
      log(`Could not start QA proxy on port ${route.listenPort}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pruneTimer = setInterval(
    () => {
      const removed = store.pruneExpired();
      if (removed.length > 0) log(`Retention: removed ${removed.length} expired session(s).`);
    },
    60 * 60 * 1000,
  );
  pruneTimer.unref?.();

  log(`ApiLens agent ${AGENT_VERSION} listening on http://${config.host}:${boundPort}`);
  log(`WebSocket: ws://${config.host}:${boundPort}/ws`);
  log(`Evidence output: ${config.outputDir}`);
  log(`Agent token: ${config.token}`);

  return {
    store,
    hub,
    port: boundPort,
    async close() {
      clearInterval(pruneTimer);
      hub.close();
      await Promise.all(proxies.map((proxy) => proxy.stop()));
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
