import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CapturedRequest, TraceSpan } from '@apilens/shared-types';
import { AGENT_PROTOCOL_VERSION } from '@apilens/shared-types';
import { redactRequest } from '@apilens/security';
import { DEFAULT_REDACTION_POLICY } from '@apilens/security';
import { AGENT_VERSION } from './config';
import type { SessionStore } from './store';
import type { AgentHub } from './hub';
import type { EvidenceWriter } from './evidence-writer';

export interface HttpApiOptions {
  token: string;
  store: SessionStore;
  hub: AgentHub;
  evidenceWriter: EvidenceWriter;
}

const MAX_INGEST_BYTES = 8 * 1024 * 1024;

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // The agent holds captured traffic; no web origin may read it directly.
    'access-control-allow-origin': 'null',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function readJson<T>(message: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    message.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INGEST_BYTES) {
        reject(new Error('Payload exceeds the 8 MB ingest limit.'));
        message.destroy();
        return;
      }
      chunks.push(chunk);
    });
    message.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
      } catch (error) {
        reject(new Error(`Body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    message.on('error', reject);
  });
}

function bearerToken(message: IncomingMessage): string | null {
  const header = message.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * The agent's HTTP surface.
 *
 * Kept intentionally small: backend SDKs push spans here, automation tooling
 * drives sessions here, and everything else uses the WebSocket channel.
 */
export function createHttpApi(options: HttpApiOptions) {
  return async function handle(message: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(message.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (message.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-origin': 'null' });
      response.end();
      return;
    }

    // Health is unauthenticated so the extension can detect the agent before
    // the user has pasted a token. It exposes no captured data.
    if (path === '/health' && message.method === 'GET') {
      json(response, 200, {
        ok: true,
        agentVersion: AGENT_VERSION,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        sessions: options.store.size(),
        peers: options.hub.peerCount(),
      });
      return;
    }

    if (bearerToken(message) !== options.token) {
      json(response, 401, { error: 'Invalid or missing agent token.' });
      return;
    }

    try {
      if (path === '/v1/spans' && message.method === 'POST') {
        const payload = await readJson<{ sessionId?: string; spans?: TraceSpan[] } | TraceSpan[]>(message);
        const spans = Array.isArray(payload) ? payload : (payload.spans ?? []);
        const sessionId = Array.isArray(payload) ? (spans[0]?.sessionId ?? '') : (payload.sessionId ?? spans[0]?.sessionId ?? '');
        if (!sessionId) {
          json(response, 400, { error: 'sessionId is required, either at the top level or on each span.' });
          return;
        }
        const stored = options.store.addSpans(sessionId, spans);
        options.hub.broadcastSpans(sessionId, stored);
        json(response, 202, { accepted: stored.length });
        return;
      }

      if (path === '/v1/requests' && message.method === 'POST') {
        const payload = await readJson<{ sessionId: string; requests: CapturedRequest[] }>(message);
        if (!payload.sessionId || !Array.isArray(payload.requests)) {
          json(response, 400, { error: 'sessionId and requests[] are required.' });
          return;
        }
        const redacted = payload.requests.map((request) => redactRequest(request, DEFAULT_REDACTION_POLICY));
        const stored = options.store.addRequests(payload.sessionId, redacted);
        options.hub.broadcastRequests(payload.sessionId, stored);
        json(response, 202, { accepted: stored.length });
        return;
      }

      if (path === '/v1/sessions' && message.method === 'GET') {
        json(response, 200, { sessions: options.store.list() });
        return;
      }

      const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
      if (sessionMatch && message.method === 'GET') {
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        const record = options.store.get(sessionId);
        if (!record) {
          json(response, 404, { error: `Session ${sessionId} not found.` });
          return;
        }
        json(response, 200, {
          session: record.session,
          requests: options.store.requests(sessionId),
          spans: options.store.spans(sessionId),
          rules: record.rules,
        });
        return;
      }

      if (sessionMatch && message.method === 'DELETE') {
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        json(response, options.store.delete(sessionId) ? 200 : 404, { deleted: sessionId });
        return;
      }

      const evidenceMatch = /^\/v1\/sessions\/([^/]+)\/evidence$/.exec(path);
      if (evidenceMatch && message.method === 'POST') {
        const sessionId = decodeURIComponent(evidenceMatch[1]!);
        const payload: { formats?: string[]; outputDir?: string } = await readJson<{
          formats?: string[];
          outputDir?: string;
        }>(message).catch(() => ({}));
        const files = await options.evidenceWriter.export(
          sessionId,
          payload.formats ?? ['json', 'har', 'markdown', 'html'],
          payload.outputDir ?? null,
        );
        json(response, 200, { files });
        return;
      }

      json(response, 404, { error: `No route for ${message.method} ${path}.` });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
