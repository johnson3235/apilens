import type { CapturedRequest, RedactionPolicy, ReplayRequest } from '@apilens/shared-types';
import { bodyText } from '@apilens/core';

/**
 * Headers a replay must never resend verbatim.
 *
 * `host`, `content-length` and friends are recalculated by the transport;
 * sending stale values produces confusing failures that look like server bugs.
 */
const TRANSPORT_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'proxy-connection',
  'accept-encoding',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'origin',
  'referer',
]);

export interface BuildReplayOptions {
  /** Redaction policy used when the original request was captured. */
  redactionPolicy?: RedactionPolicy;
  timeoutMs?: number;
  includeCredentials?: boolean;
}

/**
 * Builds an editable replay request from a captured one.
 *
 * Masked header values are dropped rather than sent as literal mask tokens,
 * and the caller is told which ones were removed so the UI can prompt for a
 * real value.
 */
export function buildReplayRequest(
  request: CapturedRequest,
  options: BuildReplayOptions = {},
): { request: ReplayRequest; droppedHeaders: string[] } {
  const maskToken = options.redactionPolicy?.maskToken;
  const droppedHeaders: string[] = [];
  const headers: Record<string, string> = {};

  Object.entries(request.requestHeaders).forEach(([name, value]) => {
    const lower = name.toLowerCase();
    if (TRANSPORT_HEADERS.has(lower)) return;
    if (maskToken && value === maskToken) {
      droppedHeaders.push(lower);
      return;
    }
    if (request.redactedFields.includes(`request.header:${lower}`)) {
      droppedHeaders.push(lower);
      return;
    }
    headers[lower] = value;
  });

  return {
    request: {
      method: request.method,
      url: request.url,
      headers,
      body: bodyText(request.requestBody),
      timeoutMs: options.timeoutMs ?? 30_000,
      includeCredentials: options.includeCredentials ?? false,
      followRedirects: true,
    },
    droppedHeaders,
  };
}

/** Rewrites a replay to point at a different environment base URL. */
export function retargetReplay(replay: ReplayRequest, baseUrl: string): ReplayRequest {
  try {
    const original = new URL(replay.url);
    const target = new URL(baseUrl);
    original.protocol = target.protocol;
    original.host = target.host;
    if (target.pathname !== '/' && !original.pathname.startsWith(target.pathname)) {
      original.pathname = `${target.pathname.replace(/\/$/, '')}${original.pathname}`;
    }
    return { ...replay, url: original.toString() };
  } catch {
    return replay;
  }
}

export function withHeader(replay: ReplayRequest, name: string, value: string): ReplayRequest {
  return { ...replay, headers: { ...replay.headers, [name.toLowerCase()]: value } };
}

export function withoutHeader(replay: ReplayRequest, name: string): ReplayRequest {
  const lower = name.toLowerCase();
  const headers = Object.fromEntries(Object.entries(replay.headers).filter(([key]) => key.toLowerCase() !== lower));
  return { ...replay, headers };
}

export function withQueryParam(replay: ReplayRequest, name: string, value: string | null): ReplayRequest {
  try {
    const url = new URL(replay.url);
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
    return { ...replay, url: url.toString() };
  } catch {
    return replay;
  }
}
