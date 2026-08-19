import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithContext, TraceContext } from './context';
import { TraceReporter } from './trace-reporter';
import { TraceSpan, SpanSource } from '@apilens/shared-types';

export interface MiddlewareOptions {
  serviceName: string;
  reporterUrl?: string;
  enabled?: boolean;
}

export function apiLensMiddleware(options: MiddlewareOptions) {
  const enabled = options.enabled !== false;
  const reporter = new TraceReporter(options.reporterUrl);

  return function (req: Request, res: Response, next: NextFunction) {
    if (!enabled) {
      return next();
    }

    const sessionId = req.headers['x-qa-session-id'] as string;
    if (!sessionId) {
      return next();
    }

    const scenarioId = req.headers['x-test-scenario-id'] as string | undefined;
    const traceparent = req.headers['traceparent'] as string | undefined;
    
    let traceId = uuidv4().replace(/-/g, '');
    let parentSpanId: string | undefined;

    if (traceparent) {
      const parts = traceparent.split('-');
      if (parts.length === 4) {
        traceId = parts[1];
        parentSpanId = parts[2];
      }
    }

    const spanId = uuidv4().replace(/-/g, '').substring(0, 16);
    const startTime = Date.now();

    const traceContext: TraceContext = {
      traceId,
      spanId,
      parentSpanId,
    };

    const newTraceparent = `00-${traceId}-${spanId}-01`;
    res.setHeader('x-qa-session-id', sessionId);
    if (scenarioId) res.setHeader('x-test-scenario-id', scenarioId);
    res.setHeader('traceparent', newTraceparent);

    runWithContext({ sessionId, scenarioId, traceContext }, () => {
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        
        const span: TraceSpan = {
          id: spanId,
          traceId,
          parentSpanId,
          sessionId,
          serviceName: options.serviceName,
          name: `${req.method} ${req.path}`,
          method: req.method,
          url: req.originalUrl || req.url,
          status: res.statusCode,
          startTime,
          duration,
          source: SpanSource.SERVER,
          requestHeaders: req.headers as Record<string, string>,
          responseHeaders: res.getHeaders() as Record<string, string>
        };

        reporter.addSpan(span);
      });

      next();
    });
  };
}
