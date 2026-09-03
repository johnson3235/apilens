import type { CapturedBody, ReplayRequest, ReplayResponse } from '@apilens/shared-types';
import { captureBody, contentTypeOf, normalizeHeaders } from '@apilens/core';

export interface ReplayExecutorOptions {
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  executedBy?: ReplayResponse['executedBy'];
  now?: () => number;
}

/**
 * Executes a replay using the platform `fetch`.
 *
 * Works unchanged in the extension (DevTools page) and in the Node agent, so
 * QA engineers can choose whether a replay goes through the browser's origin
 * and cookies or through the agent's clean context.
 */
export async function executeReplay(
  request: ReplayRequest,
  options: ReplayExecutorOptions = {},
): Promise<ReplayResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const executedBy = options.executedBy ?? 'extension';

  if (typeof fetchImpl !== 'function') {
    return {
      statusCode: null,
      statusText: null,
      headers: {},
      body: null,
      durationMs: 0,
      error: 'No fetch implementation is available in this runtime.',
      executedBy,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const startedAt = now();

  try {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body ?? undefined,
      credentials: request.includeCredentials ? 'include' : 'omit',
      redirect: request.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    });

    const headers = normalizeHeaders(response.headers);
    let body: CapturedBody | null = null;
    try {
      const text = await response.text();
      body = captureBody(text, { maxBytes: maxBodyBytes, mimeType: contentTypeOf(headers) });
    } catch (error) {
      body = {
        encoding: 'omitted',
        content: null,
        byteLength: 0,
        mimeType: contentTypeOf(headers),
        omittedReason: error instanceof Error ? error.message : 'Response body could not be read.',
      };
    }

    return {
      statusCode: response.status,
      statusText: response.statusText || null,
      headers,
      body,
      durationMs: now() - startedAt,
      error: null,
      executedBy,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      statusCode: null,
      statusText: null,
      headers: {},
      body: null,
      durationMs: now() - startedAt,
      error: aborted ? `Replay timed out after ${request.timeoutMs}ms.` : error instanceof Error ? error.message : String(error),
      executedBy,
    };
  } finally {
    clearTimeout(timer);
  }
}
