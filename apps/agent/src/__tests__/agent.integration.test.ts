import { afterEach, describe, expect, it } from 'vitest';
import type { AgentHandle } from '../server';
import { startAgent } from '../server';
import type { AgentConfig } from '../config';

const config: AgentConfig = {
  host: '127.0.0.1', port: 0, token: 'integration-test-token-that-is-long-enough',
  dataDir: '.', outputDir: '.', maxSessions: 3, maxRequestsPerSession: 100,
  maxSpansPerSession: 100, autoDeleteAfterDays: 1, proxyRoutes: [], persistSessions: false,
};

describe('local QA agent HTTP integration', () => {
  let handle: AgentHandle | null = null;
  afterEach(async () => { await handle?.close(); handle = null; });

  it('binds an ephemeral loopback port and protects captured-data routes', async () => {
    handle = await startAgent(config, () => undefined);
    expect(handle.port).toBeGreaterThan(0);
    const origin = `http://127.0.0.1:${handle.port}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, sessions: 0, peers: 0 });

    const unauthorized = await fetch(`${origin}/v1/sessions`);
    expect(unauthorized.status).toBe(401);

    const sessions = await fetch(`${origin}/v1/sessions`, { headers: { authorization: `Bearer ${config.token}` } });
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ sessions: [] });

    const missing = await fetch(`${origin}/v1/not-real`, { headers: { authorization: `Bearer ${config.token}` } });
    expect(missing.status).toBe(404);
  });
});
