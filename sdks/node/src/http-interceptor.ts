import http from 'http';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { getFullContext } from './context';
import { TraceReporter } from './trace-reporter';
import { TraceSpan } from '@apilens/shared-types';

let originalHttpRequest: typeof http.request | null = null;
let originalHttpsRequest: typeof https.request | null = null;

export function enableHttpInterception(reporter: Pick<TraceReporter, 'addSpan'>, serviceName: string): void {
  if (originalHttpRequest || originalHttpsRequest) {
    return; // Already enabled
  }

  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;

  function createInterceptor(originalRequest: any, protocol: string) {
    return function interceptor(this: any, ...args: any[]) {
      const ctx = getFullContext();
      if (!ctx) {
        return originalRequest.apply(this, args);
      }

      let options = args[0];
      let callback = args[1];

      if (typeof options === 'string' || options instanceof URL) {
        options = { href: options.toString() };
      } else {
        options = { ...options };
      }

      if (typeof args[1] === 'object') {
        options = { ...options, ...args[1] };
        callback = args[2];
      }

      options.headers = options.headers || {};
      options.headers['x-qa-session-id'] = ctx.sessionId;
      if (ctx.scenarioId) {
        options.headers['x-test-scenario-id'] = ctx.scenarioId;
      }
      if (ctx.rules?.length) {
        options.headers['x-apilens-rules'] = Buffer.from(JSON.stringify(ctx.rules), 'utf8').toString('base64');
      }
      
      const childSpanId = uuidv4().replace(/-/g, '').substring(0, 16);
      options.headers['traceparent'] = `00-${ctx.traceContext.traceId}-${childSpanId}-01`;

      const startTime = Date.now();
      const method = (options.method || 'GET').toUpperCase();
      const hostname = options.hostname || options.host || 'localhost';
      const path = options.path || '/';
      const url = `${protocol}//${hostname}${options.port ? ':' + options.port : ''}${path}`;
      const targetService = hostname;

      const req = originalRequest(options, (res: any) => {
        const duration = Date.now() - startTime;
        
        const span: TraceSpan = {
          traceId: ctx.traceContext.traceId,
          spanId: childSpanId,
          parentSpanId: ctx.traceContext.spanId,
          sessionId: ctx.sessionId,
          serviceName: serviceName,
          operationName: `Outbound ${method} ${targetService}`,
          kind: 'client',
          channel: 'server-sdk',
          method,
          url,
          statusCode: res.statusCode || 0,
          status: (res.statusCode ?? 0) >= 400 ? 'error' : 'ok',
          startedAt: startTime,
          endedAt: Date.now(),
          durationMs: duration,
          source: 'internal-service',
          attributes: {
            requestHeaders: JSON.stringify(options.headers),
            responseHeaders: JSON.stringify(res.headers),
            scenario: ctx.scenarioId ?? '',
          },
          events: [],
          error: null,
          mockedBy: null,
        };

        reporter.addSpan(span);

        if (callback) {
          callback(res);
        }
      });

      req.on('error', (err: any) => {
        const duration = Date.now() - startTime;
        
        const span: TraceSpan = {
          traceId: ctx.traceContext.traceId,
          spanId: childSpanId,
          parentSpanId: ctx.traceContext.spanId,
          sessionId: ctx.sessionId,
          serviceName: serviceName,
          operationName: `Outbound ${method} ${targetService} (Error)`,
          kind: 'client',
          channel: 'server-sdk',
          method,
          url,
          statusCode: null,
          status: 'error',
          startedAt: startTime,
          endedAt: Date.now(),
          durationMs: duration,
          source: 'internal-service',
          attributes: { requestHeaders: JSON.stringify(options.headers), scenario: ctx.scenarioId ?? '' },
          events: [],
          error: err.message,
          mockedBy: null,
        };

        reporter.addSpan(span);
      });

      return req;
    };
  }

  (http as any).request = createInterceptor(originalHttpRequest, 'http:');
  (https as any).request = createInterceptor(originalHttpsRequest, 'https:');
}

export function disableHttpInterception(): void {
  if (originalHttpRequest) {
    (http as any).request = originalHttpRequest;
    originalHttpRequest = null;
  }
  if (originalHttpsRequest) {
    (https as any).request = originalHttpsRequest;
    originalHttpsRequest = null;
  }
}
