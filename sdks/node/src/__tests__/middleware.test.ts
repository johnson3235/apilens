import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiLensMiddleware } from '../middleware';
import { getSessionId } from '../context';

vi.mock('../trace-reporter', () => {
  return {
    TraceReporter: vi.fn().mockImplementation(() => ({
      addSpan: vi.fn(),
      shutdown: vi.fn()
    }))
  };
});

describe('apiLensMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through when no QA headers present', () => {
    const middleware = apiLensMiddleware({ serviceName: 'test-service' });
    const req = { headers: {} } as any;
    const res = { setHeader: vi.fn(), on: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('creates span when QA session header present', () => {
    const middleware = apiLensMiddleware({ serviceName: 'test-service' });
    const req = { headers: { 'x-qa-session-id': 'test-session-123' }, method: 'GET', originalUrl: '/api/test' } as any;
    const res = { setHeader: vi.fn(), on: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('x-qa-session-id', 'test-session-123');
    expect(res.setHeader).toHaveBeenCalledWith(expect.stringMatching(/traceparent/), expect.any(String));
  });
  
  // Add more tests to reach 10+
  it('respects disabled flag', () => {
    const middleware = apiLensMiddleware({ serviceName: 'test-service', enabled: false });
    const req = { headers: { 'x-qa-session-id': 'test' } } as any;
    const res = { setHeader: vi.fn() } as any;
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('returns the configured mock response before the route handler', async () => {
    const rules = [{
      id: 'rule-1', scenarioId: 'test', name: '503 payment', description: '', enabled: true,
      priority: 1, conditions: [{ field: 'path', operator: 'contains', value: '/payments' }],
      conditionLogic: 'and', action: { type: 'status-code', statusCode: 503, responseBody: '{"error":"mocked"}' },
      applyMode: 'always', appliedCount: 0, createdAt: 1, updatedAt: 1
    }];
    const middleware = apiLensMiddleware({ serviceName: 'payments' });
    const req = {
      headers: {
        host: 'localhost:4001',
        'x-qa-session-id': 'test-session',
        'x-apilens-rules': Buffer.from(JSON.stringify(rules)).toString('base64')
      },
      method: 'POST', protocol: 'http', path: '/api/payments', originalUrl: '/api/payments',
      hostname: 'localhost', query: {}, body: {}
    } as any;
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    const res = {
      setHeader: vi.fn(), hasHeader: vi.fn(() => false), on: vi.fn(), status
    } as any;
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(503);
    expect(send).toHaveBeenCalledWith('{"error":"mocked"}');
    expect(res.setHeader).toHaveBeenCalledWith('X-ApiLens-Mocked', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('X-ApiLens-Transport', 'server-sdk');
  });
});
