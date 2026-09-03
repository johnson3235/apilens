import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithContext, TraceContext } from './context';
import { TraceReporter } from './trace-reporter';
import type { RequestMethod, Rule, TraceSpan } from '@apilens/shared-types';
import { captureBody, createCapturedRequest } from '@apilens/core';
import { executeAction, findMatchingRule } from '@apilens/mock-engine';
import { redactHeaders } from './redaction';

function decodeRules(value: string | undefined): Rule[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export interface MiddlewareOptions {
  serviceName: string;
  reporterUrl?: string;
  enabled?: boolean;
}

export function apiLensMiddleware(options: MiddlewareOptions) {
  const enabled = options.enabled !== false;
  const reporter = new TraceReporter(options.reporterUrl);

  return async function (req: Request, res: Response, next: NextFunction) {
    if (!enabled) {
      return next();
    }

    const sessionId = req.headers['x-qa-session-id'] as string;
    if (!sessionId) {
      return next();
    }

    const scenarioId = req.headers['x-test-scenario-id'] as string | undefined;
    const rules = decodeRules(req.headers['x-apilens-rules'] as string | undefined);
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

    const requestUrl = `${req.protocol || 'http'}://${typeof req.get === 'function' ? req.get('host') : (req.headers.host || 'localhost')}${req.originalUrl || req.url || '/'}`;
    const requestHeaders = Object.fromEntries(
      Object.entries(req.headers).flatMap(([name, value]) => value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]]),
    );
    const requestBodyText = req.body === undefined || req.body === null ? null : JSON.stringify(req.body);
    const requestForRules = {
      ...createCapturedRequest({
        sessionId,
        url: requestUrl,
        method: req.method.toUpperCase() as RequestMethod,
        channel: 'server-sdk',
        source: 'internal-service',
        originId: options.serviceName,
      }),
      path: req.path || req.url || '/',
      hostname: req.hostname || req.headers.host || 'localhost',
      queryParams: Object.fromEntries(Object.entries(req.query ?? {}).map(([name, value]) => [name, String(value)])),
      requestHeaders,
      requestBody: captureBody(requestBodyText, { maxBytes: 256 * 1024, mimeType: req.get?.('content-type') ?? 'application/json' }),
      serviceName: options.serviceName,
    };
    const match = findMatchingRule(rules, requestForRules);

    runWithContext({ sessionId, scenarioId, rules, traceContext }, () => {
      res.on('finish', () => {
        const duration = Date.now() - startTime;
        
        const span: TraceSpan = {
          traceId,
          spanId,
          parentSpanId: parentSpanId || null,
          sessionId,
          serviceName: options.serviceName,
          operationName: `${req.method} ${req.path}`,
          kind: 'server',
          channel: 'server-sdk',
          method: req.method,
          url: req.originalUrl || req.url,
          statusCode: res.statusCode,
          status: res.statusCode >= 400 ? 'error' : 'ok',
          startedAt: startTime,
          endedAt: Date.now(),
          durationMs: duration,
          source: 'internal-service',
          attributes: {
            mocked: Boolean(match.matched),
            scenario: match.rule?.name ?? '',
            requestHeaders: JSON.stringify(redactHeaders(requestHeaders)),
            responseHeaders: JSON.stringify(redactHeaders(Object.fromEntries(
              Object.entries(res.getHeaders()).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]),
            )))
          },
          events: [],
          error: res.statusCode >= 500 ? `HTTP ${res.statusCode}` : null,
          mockedBy: match.rule?.name ?? null,
        };

        reporter.addSpan(span);
      });

      if (!match.matched || !match.action || !match.rule) {
        next();
        return;
      }

      const mock = executeAction(match.action, { ruleName: match.rule.name });
      match.rule.appliedCount = (match.rule.appliedCount || 0) + 1;
      const sendMock = () => {
        Object.entries(mock.headers).forEach(([name, value]) => res.setHeader(name, String(value)));
        if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-ApiLens-Mocked', 'true');
        res.setHeader('X-ApiLens-Rule', match.rule!.name);
        res.setHeader('X-ApiLens-Transport', 'server-sdk');
        res.setHeader('X-ApiLens-Session', sessionId);
        res.status(mock.statusCode).send(mock.body);
      };
      if (mock.delayMs > 0) setTimeout(sendMock, mock.delayMs);
      else sendMock();
    });
  };
}
