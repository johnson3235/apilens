import type { CapturedRequest } from '@apilens/shared-types';

/**
 * Extracting captured traffic out of ApiLens.
 *
 * A defect report, a Postman import and a reproduction script all need the
 * same call in a different shape. Everything here works on the *filtered* list
 * the tester is looking at, so what they see is exactly what they get.
 *
 * Redaction has already been applied upstream; these helpers never re-derive
 * values from raw data, so a `[REDACTED]` header stays redacted in every
 * exported format.
 */

export type ExtractFormat = 'curl' | 'fetch' | 'json' | 'csv' | 'har' | 'urls' | 'markdown';

export const EXTRACT_FORMATS: Array<{ id: ExtractFormat; label: string; hint: string; extension: string; mime: string }> = [
  { id: 'curl', label: 'cURL commands', hint: 'Reproduce a call from a terminal', extension: 'sh', mime: 'text/plain' },
  { id: 'fetch', label: 'fetch() snippets', hint: 'Paste into a browser console or test', extension: 'js', mime: 'text/javascript' },
  { id: 'json', label: 'JSON', hint: 'Full records including payloads', extension: 'json', mime: 'application/json' },
  { id: 'csv', label: 'CSV summary', hint: 'One row per call for a spreadsheet', extension: 'csv', mime: 'text/csv' },
  { id: 'har', label: 'HAR 1.2', hint: 'Open in DevTools, Charles or Fiddler', extension: 'har', mime: 'application/json' },
  { id: 'urls', label: 'URL list', hint: 'Just the endpoints, de-duplicated', extension: 'txt', mime: 'text/plain' },
  { id: 'markdown', label: 'Markdown table', hint: 'Paste into a Jira or ADO defect', extension: 'md', mime: 'text/markdown' },
];

/** Single-quote shell escaping, safe for values containing quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bodyContent(request: CapturedRequest): string | null {
  const body = request.requestBody;
  if (!body || body.content === null || body.encoding === 'omitted') return null;
  return body.content;
}

export function toCurl(request: CapturedRequest): string {
  const parts = [`curl -i -X ${request.method} ${shellQuote(request.url)}`];
  for (const [name, value] of Object.entries(request.requestHeaders)) {
    parts.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  }
  const body = bodyContent(request);
  if (body !== null) parts.push(`  --data-raw ${shellQuote(body)}`);
  const header = `# ${request.method} ${request.path} → ${request.statusCode ?? request.error ?? 'pending'}`;
  return `${header}\n${parts.join(' \\\n')}`;
}

export function toFetchSnippet(request: CapturedRequest): string {
  const init: Record<string, unknown> = { method: request.method };
  if (Object.keys(request.requestHeaders).length > 0) init.headers = request.requestHeaders;
  const body = bodyContent(request);
  if (body !== null) init.body = body;
  return `// ${request.method} ${request.path} → ${request.statusCode ?? request.error ?? 'pending'}\nawait fetch(${JSON.stringify(request.url)}, ${JSON.stringify(init, null, 2)});`;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(requests: CapturedRequest[]): string {
  const columns = ['startedAt', 'method', 'status', 'durationMs', 'host', 'path', 'type', 'channel', 'mockedBy', 'error', 'page'];
  const rows = requests.map((request) =>
    [
      new Date(request.timing.startedAt).toISOString(),
      request.method,
      request.statusCode ?? '',
      request.timing.durationMs ?? '',
      request.hostname,
      request.path,
      request.type,
      request.channel,
      request.mock?.ruleName ?? '',
      request.error ?? '',
      request.pageUrl ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return [columns.join(','), ...rows].join('\n');
}

export function toUrlList(requests: CapturedRequest[]): string {
  const seen = new Set<string>();
  for (const request of requests) seen.add(`${request.method} ${request.url}`);
  return [...seen].sort().join('\n');
}

export function toMarkdownTable(requests: CapturedRequest[]): string {
  const header = '| Method | Path | Status | Duration | Source | Mocked |\n|---|---|---|---|---|---|';
  const rows = requests.map((request) => {
    const status = request.error ? `error: ${request.error}` : String(request.statusCode ?? '—');
    const duration = request.timing.durationMs === null ? '—' : `${Math.round(request.timing.durationMs)} ms`;
    return `| ${request.method} | \`${request.path}\` | ${status} | ${duration} | ${request.channel} | ${request.mock?.ruleName ?? '—'} |`;
  });
  return [header, ...rows].join('\n');
}

function harHeaders(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/**
 * HAR 1.2 for the current selection.
 *
 * Written here rather than reusing the evidence exporter because that one
 * needs a completed session; a tester filtering live traffic must be able to
 * extract what is on screen right now.
 */
export function toHarDocument(requests: CapturedRequest[], creatorVersion: string): string {
  const entries = requests.map((request) => {
    const queryString = Object.entries(request.queryParams).map(([name, value]) => ({ name, value: String(value) }));
    const requestBody = bodyContent(request);
    return {
      startedDateTime: new Date(request.timing.startedAt).toISOString(),
      time: request.timing.durationMs ?? -1,
      request: {
        method: request.method,
        url: request.url,
        httpVersion: 'HTTP/1.1',
        headers: harHeaders(request.requestHeaders),
        queryString,
        cookies: [],
        headersSize: -1,
        bodySize: request.requestBody?.byteLength ?? -1,
        ...(requestBody === null
          ? {}
          : { postData: { mimeType: request.requestBody?.mimeType ?? 'application/json', text: requestBody } }),
      },
      response: {
        status: request.statusCode ?? 0,
        statusText: request.statusText ?? '',
        httpVersion: 'HTTP/1.1',
        headers: harHeaders(request.responseHeaders),
        cookies: [],
        content: {
          size: request.responseBody?.byteLength ?? 0,
          mimeType: request.responseBody?.mimeType ?? '',
          text: request.responseBody?.content ?? '',
          ...(request.responseBody?.encoding === 'truncated' ? { comment: 'Truncated by ApiLens capture limits' } : {}),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: request.responseBody?.byteLength ?? -1,
      },
      cache: {},
      timings: { send: 0, wait: request.timing.durationMs ?? -1, receive: 0 },
      serverIPAddress: '',
      comment: [
        `channel: ${request.channel}`,
        request.mock ? `mocked by: ${request.mock.ruleName}` : null,
        request.error ? `error: ${request.error}` : null,
        request.pageUrl ? `page: ${request.pageUrl}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  });

  return JSON.stringify(
    { log: { version: '1.2', creator: { name: 'ApiLens', version: creatorVersion }, pages: [], entries } },
    null,
    2,
  );
}

export interface ExtractResult {
  filename: string;
  mime: string;
  content: string;
}

export function extract(
  requests: CapturedRequest[],
  format: ExtractFormat,
  options: { version: string; label?: string } = { version: '0.0.0' },
): ExtractResult {
  const descriptor = EXTRACT_FORMATS.find((item) => item.id === format) ?? EXTRACT_FORMATS[0]!;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const label = (options.label ?? 'apilens-calls').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const filename = `${label}-${stamp}.${descriptor.extension}`;

  switch (format) {
    case 'curl':
      return { filename, mime: descriptor.mime, content: requests.map(toCurl).join('\n\n') };
    case 'fetch':
      return { filename, mime: descriptor.mime, content: requests.map(toFetchSnippet).join('\n\n') };
    case 'csv':
      return { filename, mime: descriptor.mime, content: toCsv(requests) };
    case 'urls':
      return { filename, mime: descriptor.mime, content: toUrlList(requests) };
    case 'markdown':
      return { filename, mime: descriptor.mime, content: toMarkdownTable(requests) };
    case 'har':
      return { filename, mime: descriptor.mime, content: toHarDocument(requests, options.version) };
    case 'json':
    default:
      return { filename, mime: descriptor.mime, content: JSON.stringify(requests, null, 2) };
  }
}
