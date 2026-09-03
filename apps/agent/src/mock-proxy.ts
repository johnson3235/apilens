import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CapturedRequest, EnvironmentPolicy, RequestMethod, TraceSpan } from '@apilens/shared-types';
import { DEFAULT_ENVIRONMENT_POLICY } from '@apilens/shared-types';
import {
  captureBody,
  completeRequest,
  contentTypeOf,
  createCapturedRequest,
  createSpanId,
  createTraceId,
  normalizeHeaders,
  parseUrl,
} from '@apilens/core';
import { decideMock, executeAction, mockMarkerHeaders } from '@apilens/mock-engine';
import { extractTraceContext, formatTraceparent } from '@apilens/trace-engine';
import { redactRequest } from '@apilens/security';
import { DEFAULT_REDACTION_POLICY } from '@apilens/security';
import type { ProxyRouteConfig } from './config';
import type { SessionStore } from './store';

export interface ProxyEvents {
  onRequest(sessionId: string, request: CapturedRequest): void;
  onSpan(sessionId: string, span: TraceSpan): void;
  log(message: string): void;
}

const MAX_BODY_BYTES = 512 * 1024;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function readBody(message: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    message.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Keep only what we can store; the upstream still receives everything.
      if (size <= MAX_BODY_BYTES * 4) chunks.push(chunk);
    });
    message.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    message.on('error', reject);
  });
}

function forwardableHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name.toLowerCase())));
}

/**
 * A QA reverse proxy that sits **in front of a backend service**.
 *
 * This is the honest answer to server-side mocking: a browser extension cannot
 * intercept a call made from an SSR server to a downstream microservice, but a
 * proxy that the SSR server is pointed at absolutely can. The proxy applies
 * exactly the same rule engine as the browser, so a QA engineer writes one rule
 * and it works on either side of the boundary.
 */
export class MockProxy {
  private server: Server | null = null;

  constructor(
    private readonly route: ProxyRouteConfig,
    private readonly store: SessionStore,
    private readonly events: ProxyEvents,
    private readonly policy: EnvironmentPolicy = DEFAULT_ENVIRONMENT_POLICY,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((incoming, outgoing) => {
        void this.handle(incoming, outgoing).catch((error: unknown) => {
          this.events.log(`Proxy ${this.route.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'ApiLens QA proxy could not reach the upstream service.' }));
        });
      });
      this.server.on('error', reject);
      // Loopback only: a QA proxy must never be reachable from the network.
      this.server.listen(this.route.listenPort, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private async handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    const sessionId = this.store.activeSessionId() ?? 'proxy-session';
    const target = parseUrl(this.route.target);
    const url = `${this.route.target}${incoming.url ?? '/'}`;
    const method = (incoming.method ?? 'GET').toUpperCase() as RequestMethod;
    const requestHeaders = normalizeHeaders(incoming.headers);
    const requestBodyText = await readBody(incoming);

    let captured: CapturedRequest = {
      ...createCapturedRequest({
        sessionId,
        url,
        method,
        channel: 'qa-proxy',
        source: 'internal-service',
        type: 'server',
        originId: this.route.id,
      }),
      requestHeaders,
      requestBody: requestBodyText
        ? captureBody(requestBodyText, { maxBytes: MAX_BODY_BYTES, mimeType: contentTypeOf(requestHeaders) })
        : null,
      serviceName: target.hostname,
      environmentId: this.route.environmentId,
    };

    const context = extractTraceContext(requestHeaders);
    const traceId = context?.traceId ?? createTraceId();
    const spanId = createSpanId();
    captured = { ...captured, traceId, spanId, parentSpanId: context?.spanId ?? null, correlationId: context?.correlationId ?? null };

    // Environment safety runs against the *upstream* host, not the loopback
    // address the proxy listens on, so production targets stay protected.
    const decision = decideMock(this.store.getAllActiveRules(), { ...captured, hostname: target.hostname }, this.policy, {
      environmentId: this.route.environmentId,
    });

    if (decision.kind === 'apply' && !decision.rule.action.fieldMutations?.length) {
      const outcome = executeAction(decision.rule.action, { ruleName: decision.rule.name });
      if (!outcome.requiresOriginalResponse) {
        await this.serveMock(outgoing, captured, decision.rule.id, decision.rule.name, outcome, sessionId);
        return;
      }
    }

    await this.forward(incoming, outgoing, captured, sessionId, decision);
  }

  private async serveMock(
    outgoing: ServerResponse,
    captured: CapturedRequest,
    ruleId: string,
    ruleName: string,
    outcome: ReturnType<typeof executeAction>,
    sessionId: string,
  ): Promise<void> {
    if (outcome.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));

    if (outcome.abort) {
      outgoing.destroy();
      this.record(
        completeRequest(
          {
            ...captured,
            mock: { ruleId, ruleName, scenarioId: null, transport: 'qa-proxy', failureType: outcome.errorReason ?? 'aborted', appliedAt: Date.now() },
            error: `Connection aborted by ApiLens rule "${ruleName}" (${outcome.errorReason ?? 'Failed'}).`,
          },
          { statusCode: null },
        ),
        sessionId,
      );
      return;
    }

    const headers = { ...outcome.headers, ...mockMarkerHeaders(ruleName, 'qa-proxy', outcome.statusCode >= 400 ? 'error' : 'ok') };
    outgoing.writeHead(outcome.statusCode, headers);
    outgoing.end(outcome.body);

    this.record(
      completeRequest(
        {
          ...captured,
          responseHeaders: normalizeHeaders(headers),
          responseBody: captureBody(outcome.body, { maxBytes: MAX_BODY_BYTES, mimeType: contentTypeOf(headers) }),
          mock: { ruleId, ruleName, scenarioId: null, transport: 'qa-proxy', failureType: 'mocked', appliedAt: Date.now() },
          timing: { ...captured.timing, injectedDelayMs: outcome.delayMs || null },
        },
        { statusCode: outcome.statusCode, statusText: outcome.statusText },
      ),
      sessionId,
    );
  }

  private forward(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    captured: CapturedRequest,
    sessionId: string,
    decision: ReturnType<typeof decideMock>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = new URL(this.route.target);
      const isHttps = target.protocol === 'https:';
      const send = isHttps ? httpsRequest : httpRequest;

      const headers = forwardableHeaders(captured.requestHeaders);
      headers.traceparent = formatTraceparent(captured.traceId!, captured.spanId!, true);
      headers['x-apilens-proxy'] = this.route.id;

      const upstream = send(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: incoming.url ?? '/',
          method: captured.method,
          headers,
        },
        (response) => {
          const responseHeaders = normalizeHeaders(response.headers);
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const originalBody = Buffer.concat(chunks).toString('utf8');
            void this.completeForward(outgoing, captured, sessionId, decision, response, responseHeaders, originalBody)
              .then(resolve)
              .catch(reject);
          });
          response.on('error', reject);
        },
      );

      upstream.on('error', (error: Error) => {
        if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ error: `Upstream unreachable: ${error.message}` }));
        this.record(completeRequest({ ...captured, error: error.message }, { statusCode: null }), sessionId);
        resolve();
      });

      if (captured.requestBody?.content) upstream.write(captured.requestBody.content);
      upstream.end();
    });
  }

  private async completeForward(
    outgoing: ServerResponse,
    captured: CapturedRequest,
    sessionId: string,
    decision: ReturnType<typeof decideMock>,
    response: IncomingMessage,
    responseHeaders: Record<string, string>,
    originalBody: string,
  ): Promise<void> {
    let status = response.statusCode ?? 200;
    let body = originalBody;
    let headers: Record<string, string> = { ...responseHeaders };
    let mock: CapturedRequest['mock'] = null;
    let injectedDelayMs: number | null = null;

    if (decision.kind === 'apply') {
      const outcome = executeAction(decision.rule.action, {
        ruleName: decision.rule.name,
        originalBody,
        originalStatus: status,
        originalHeaders: responseHeaders,
      });
      if (outcome.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
        injectedDelayMs = outcome.delayMs;
      }
      if (decision.rule.action.type !== 'slow-response') {
        status = outcome.statusCode;
        body = outcome.body;
      }
      headers = {
        ...headers,
        ...outcome.headers,
        ...mockMarkerHeaders(decision.rule.name, 'qa-proxy', decision.rule.action.type),
      };
      outcome.removeHeaders.forEach((name) => delete headers[name.toLowerCase()]);
      mock = {
        ruleId: decision.rule.id,
        ruleName: decision.rule.name,
        scenarioId: decision.rule.scenarioId,
        transport: 'qa-proxy',
        failureType: decision.rule.action.type,
        appliedAt: Date.now(),
      };
    }

    delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];

    outgoing.writeHead(status, headers);
    outgoing.end(body);

    this.record(
      completeRequest(
        {
          ...captured,
          responseHeaders: headers,
          responseBody: captureBody(body, { maxBytes: MAX_BODY_BYTES, mimeType: contentTypeOf(headers) }),
          mock,
          timing: { ...captured.timing, injectedDelayMs },
        },
        { statusCode: status, statusText: response.statusMessage ?? null },
      ),
      sessionId,
    );
  }

  private record(request: CapturedRequest, sessionId: string): void {
    const redacted = redactRequest(request, DEFAULT_REDACTION_POLICY);
    this.store.addRequests(sessionId, [redacted]);
    this.events.onRequest(sessionId, redacted);

    const span: TraceSpan = {
      spanId: redacted.spanId ?? createSpanId(),
      traceId: redacted.traceId ?? createTraceId(),
      parentSpanId: redacted.parentSpanId,
      sessionId,
      serviceName: redacted.serviceName ?? this.route.id,
      operationName: `${redacted.method} ${redacted.path}`,
      kind: 'server',
      source: 'internal-service',
      channel: 'qa-proxy',
      method: redacted.method,
      url: redacted.url,
      statusCode: redacted.statusCode,
      status: redacted.error !== null || (redacted.statusCode ?? 0) >= 400 ? 'error' : 'ok',
      startedAt: redacted.timing.startedAt,
      endedAt: redacted.timing.completedAt ?? redacted.timing.startedAt,
      durationMs: redacted.timing.durationMs ?? 0,
      attributes: { 'apilens.proxy_route': this.route.id },
      events: [],
      error: redacted.error,
      mockedBy: redacted.mock?.ruleName ?? null,
    };
    this.store.addSpans(sessionId, [span]);
    this.events.onSpan(sessionId, span);
  }
}
