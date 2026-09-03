import type { CapturedRequest, EvidenceBundle, EvidenceArtifact } from '@apilens/shared-types';
import { bodyText, isStaticAssetPath } from '@apilens/core';

interface HarNameValue {
  name: string;
  value: string;
}

function toNameValues(headers: Record<string, string>): HarNameValue[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryStringOf(request: CapturedRequest): HarNameValue[] {
  return Object.entries(request.queryParams).map(([name, value]) => ({ name, value }));
}

function isoOf(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Exports captured traffic as HAR 1.2.
 *
 * HAR is the lingua franca for network evidence: it opens in Chrome DevTools,
 * Charles, Proxyman, Fiddler and most defect trackers' viewers, which makes an
 * ApiLens session immediately useful to developers who don't have the
 * extension installed.
 */
export function toHar(bundle: EvidenceBundle, includeStatic: boolean): string {
  const requests = includeStatic
    ? bundle.requests
    : bundle.requests.filter((request) => request.type !== 'static' && !isStaticAssetPath(request.path));

  const entries = requests.map((request) => {
    const requestBodyText = bodyText(request.requestBody);
    const responseBodyText = bodyText(request.responseBody);
    const wait = request.timing.durationMs ?? 0;

    return {
      pageref: 'page_1',
      startedDateTime: isoOf(request.timing.startedAt),
      time: wait,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: toNameValues(request.requestHeaders),
        queryString: queryStringOf(request),
        headersSize: -1,
        bodySize: request.requestBody?.byteLength ?? 0,
        ...(requestBodyText !== null
          ? { postData: { mimeType: request.requestBody?.mimeType ?? 'text/plain', text: requestBodyText } }
          : {}),
      },
      response: {
        status: request.statusCode ?? 0,
        statusText: request.statusText ?? (request.error ? 'Failed' : ''),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: toNameValues(request.responseHeaders),
        content: {
          size: request.responseBody?.byteLength ?? 0,
          mimeType: request.responseBody?.mimeType ?? '',
          ...(responseBodyText !== null ? { text: responseBodyText } : {}),
          ...(request.responseBody?.omittedReason ? { comment: request.responseBody.omittedReason } : {}),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: request.responseBody?.byteLength ?? 0,
      },
      cache: {},
      timings: { send: 0, wait, receive: 0 },
      serverIPAddress: '',
      connection: '',
      comment: [
        `apilens.channel=${request.channel}`,
        `apilens.source=${request.source}`,
        request.mock ? `apilens.mocked_by=${request.mock.ruleName}` : null,
        request.traceId ? `apilens.trace_id=${request.traceId}` : null,
        request.error ? `apilens.error=${request.error}` : null,
        request.redactedFields.length > 0 ? `apilens.redacted=${request.redactedFields.join(',')}` : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  });

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'ApiLens', version: bundle.environment.extensionVersion },
      browser: { name: bundle.environment.browser ?? 'unknown', version: '' },
      pages: [
        {
          startedDateTime: isoOf(bundle.session.startedAt),
          id: 'page_1',
          title: bundle.session.name,
          pageTimings: { onContentLoad: -1, onLoad: -1 },
        },
      ],
      entries,
      comment: bundle.containsUnmaskedSecrets
        ? 'WARNING: redaction was disabled for this export. Treat this file as a secret.'
        : 'Sensitive headers and payload fields were masked by ApiLens before export.',
    },
  };

  return JSON.stringify(har, null, 2);
}

export function harArtifact(bundle: EvidenceBundle, includeStatic: boolean): EvidenceArtifact {
  return {
    fileName: `${slug(bundle.session.name)}.har`,
    contentType: 'application/json',
    content: toHar(bundle, includeStatic),
  };
}

export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'apilens-session'
  );
}
