import http from 'http';
import https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { getFullContext } from './context';
import { TraceReporter } from './trace-reporter';
import { TraceSpan, SpanSource } from '@apilens/shared-types';

let originalHttpRequest: typeof http.request | null = null;
let originalHttpsRequest: typeof https.request | null = null;

export function enableHttpInterception(reporter: TraceReporter, serviceName: string) {
  if (originalHttpRequest || originalHttpsRequest) {
    return; // Already enabled
  }

  originalHttpRequest = http.request;
  originalHttpsRequest = https.request;

  function createInterceptor(originalRequest: any, protocol: string) {
    return function interceptor(...args: any[]) {
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
          id: childSpanId,
          traceId: ctx.traceContext.traceId,
          parentSpanId: ctx.traceContext.spanId,
          sessionId: ctx.sessionId,
          serviceName: serviceName,
          name: `Outbound ${method} ${targetService}`,
          method,
          url,
          status: res.statusCode || 0,
          startTime,
          duration,
          source: SpanSource.SERVER,
          requestHeaders: options.headers as Record<string, string>,
          responseHeaders: res.headers as Record<string, string>
        };

        reporter.addSpan(span);

        if (callback) {
          callback(res);
        }
      });

      req.on('error', (err: any) => {
        const duration = Date.now() - startTime;
        
        const span: TraceSpan = {
          id: childSpanId,
          traceId: ctx.traceContext.traceId,
          parentSpanId: ctx.traceContext.spanId,
          sessionId: ctx.sessionId,
          serviceName: serviceName,
          name: `Outbound ${method} ${targetService} (Error)`,
          method,
          url,
          status: 0,
          startTime,
          duration,
          source: SpanSource.SERVER,
          requestHeaders: options.headers as Record<string, string>,
          responseHeaders: {}
        };

        reporter.addSpan(span);
      });

      return req;
    };
  }

  (http as any).request = createInterceptor(originalHttpRequest, 'http:');
  (https as any).request = createInterceptor(originalHttpsRequest, 'https:');
}

export function disableHttpInterception() {
  if (originalHttpRequest) {
    (http as any).request = originalHttpRequest;
    originalHttpRequest = null;
  }
  if (originalHttpsRequest) {
    (https as any).request = originalHttpsRequest;
    originalHttpsRequest = null;
  }
}
