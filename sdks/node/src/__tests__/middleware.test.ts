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
});
