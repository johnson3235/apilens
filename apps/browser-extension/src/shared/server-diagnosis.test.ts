import { describe, expect, it } from 'vitest';
import { diagnoseCapture } from './server-diagnosis';
import type { ServerBridgeStatus, ServerCaptureStats, ServerControlHealth } from './server-control';

const capture = (overrides: Partial<ServerCaptureStats> = {}): ServerCaptureStats => ({
  installed: true, installedBy: 'boot', requestsSeen: 4, requestsRecorded: 2,
  skipped: { ignoredPath: 0, noSession: 0, originNotAllowed: 0, noBackendCall: 0 },
  lastRejectedOrigin: null, learnedOrigins: [], backendCalls: 5, cacheHits: 0, middlewareRuns: 0, lastRequestAt: 1,
  ...overrides,
});

function status(health: Partial<ServerControlHealth> = {}, extra: Partial<ServerBridgeStatus> = {}): ServerBridgeStatus {
  return {
    configured: true, connected: true, endpoint: 'https://clear.example/api/__apilens', error: null, lastSyncAt: 1, gap: false,
    callCount: 0, ruleCount: 0, processId: 'p1',
    health: {
      ok: true, protocolVersion: 2, sdkVersion: '0.5.0', serviceName: 'clear-bff', processId: 'p1', startedAt: 0, enabled: true,
      captureRequestBodies: true, captureResponseBodies: true, maxBodyBytes: 1, mockingEnabled: true, routeMocksEnabled: false,
      bufferedCalls: 0, latestSeq: 0, droppedCalls: 0, ruleCount: 0, activeRuleCount: 0,
      agentDelivery: { accepted: 0, dropped: 0, lastError: null }, capture: capture(), ...health,
    },
    ...extra,
  };
}

describe('diagnoseCapture', () => {
  it('says nothing while not connected', () => {
    expect(diagnoseCapture(null, 0)).toBeNull();
    expect(diagnoseCapture({ ...status(), connected: false }, 0)).toBeNull();
  });

  it('leads with a capture that never started, and hands over the instrumentation fix', () => {
    const result = diagnoseCapture(status({ capture: capture({ installed: false, installedBy: null, requestsSeen: 0, requestsRecorded: 0 }) }), 0)!;
    expect(result.tone).toBe('fail');
    expect(result.headline).toBe('Capture was never switched on');
    expect(result.checks.find((check) => check.id === 'installed')?.fix).toContain('instrumentationHook');
    expect(result.checks.some((check) => check.id === 'traffic')).toBe(false);
  });

  it('names the rejected address and the line to add', () => {
    const result = diagnoseCapture(status({ capture: capture({ requestsRecorded: 0, skipped: { ignoredPath: 0, noSession: 0, originNotAllowed: 6, noBackendCall: 0 }, lastRejectedOrigin: 'http://10.2.3.4:3000' }) }), 0)!;
    expect(result.tone).toBe('fail');
    expect(result.headline).toBe('6 requests ignored: unknown app address');
    expect(result.checks.find((check) => check.id === 'origin')?.fix).toBe("allowedAppOrigins: ['http://10.2.3.4:3000'],");
  });

  it('explains requests without a QA session', () => {
    const result = diagnoseCapture(status({ capture: capture({ requestsRecorded: 0, skipped: { ignoredPath: 0, noSession: 3, originNotAllowed: 0, noBackendCall: 0 } }) }), 0)!;
    expect(result.headline).toBe('3 requests ignored: no QA session');
    expect(result.checks.find((check) => check.id === 'session')?.fix).toBe('captureWithoutSession: true,');
  });

  it('points at browser calls when pages made no server-side call', () => {
    const result = diagnoseCapture(status({ capture: capture({ requestsRecorded: 0, backendCalls: 0, skipped: { ignoredPath: 0, noSession: 0, originNotAllowed: 0, noBackendCall: 4 } }) }), 0)!;
    expect(result.checks.find((check) => check.id === 'backend')?.detail).toContain('Browser calls');
  });

  it('warns that capture started late, and reports a disabled SDK first', () => {
    expect(diagnoseCapture(status({ capture: capture({ installedBy: 'first-connection' }) }), 3)!.tone).toBe('warn');
    expect(diagnoseCapture(status({ enabled: false }), 0)!.headline).toBe('ApiLens is off in the app');
  });

  it('is calm when everything works, and falls back to hints for older SDKs', () => {
    expect(diagnoseCapture(status(), 7)).toMatchObject({ tone: 'ok', headline: 'Capture is working' });
    const old = diagnoseCapture(status({ sdkVersion: '0.4.0', capture: undefined }), 0)!;
    expect(old.checks.find((check) => check.id === 'old-sdk')?.detail).toContain('instrumentationHook');
  });

  it('mentions the load balancer when several pods answer and none saw traffic', () => {
    const result = diagnoseCapture(status({ capture: capture({ requestsSeen: 0, requestsRecorded: 0 }) }, {
      pods: [
        { processId: 'a', serviceName: 'clear-bff', lastSeenAt: 1, bufferedCalls: 0, gap: false },
        { processId: 'b', serviceName: 'clear-bff', lastSeenAt: 1, bufferedCalls: 0, gap: false },
      ],
    }), 0)!;
    expect(result.checks.find((check) => check.id === 'traffic')?.detail).toContain('2 server pods');
  });
});
