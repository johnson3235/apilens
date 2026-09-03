import { describe, expect, it } from 'vitest';
import { traceHeadersFor } from './trace-propagation';

const active = { enabled: true, sessionId: 'session-1', scenarioId: 'scenario-1', origin: 'http://localhost:3000' };
describe('opt-in QA propagation', () => {
  it('generates real same-origin correlation headers and keeps diagnostic headers', () => {
    const result = traceHeadersFor({ accept: 'application/json' }, '/api/products', active.origin, active);
    expect(result['x-qa-session-id']).toBe('session-1');
    expect(result['x-test-scenario-id']).toBe('scenario-1');
    expect(result.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(result.accept).toBe('application/json');
  });
  it('does not alter traffic with injection off, no session or a different origin', () => {
    const headers = { accept: 'application/json' };
    expect(traceHeadersFor(headers, '/api', active.origin, { ...active, enabled: false })).toBe(headers);
    expect(traceHeadersFor(headers, '/api', active.origin, { ...active, sessionId: null })).toBe(headers);
    expect(traceHeadersFor(headers, 'https://third-party.test/api', active.origin, active)).toBe(headers);
    expect(traceHeadersFor(headers, '/api', 'http://localhost:4000', active)).toBe(headers);
  });
  it('preserves existing W3C context', () => {
    const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    expect(traceHeadersFor({ traceparent }, '/api', active.origin, active).traceparent).toBe(traceparent);
  });
});
