import { describe, expect, it } from 'vitest';
import { createCapturedRequest } from '@apilens/core';
import type { CapturedRequest } from '@apilens/shared-types';
import { extract, toCsv, toCurl, toFetchSnippet, toHarDocument, toMarkdownTable, toUrlList } from './request-export';

function make(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  const base = createCapturedRequest({
    sessionId: 'qa',
    url: 'https://api.example.com/v2/billing?contactId=3055861',
    method: 'POST',
    channel: 'page-hook',
    startedAt: 1_700_000_000_000,
  });
  return {
    ...base,
    statusCode: 200,
    statusText: 'OK',
    timing: { startedAt: 1_700_000_000_000, completedAt: 1_700_000_000_250, durationMs: 250, injectedDelayMs: null },
    requestHeaders: { 'content-type': 'application/json', authorization: '[REDACTED]' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: { encoding: 'utf8', content: '{"contactId":"3055861"}', byteLength: 23, mimeType: 'application/json', omittedReason: null },
    responseBody: { encoding: 'utf8', content: '{"amountDue":42.5}', byteLength: 18, mimeType: 'application/json', omittedReason: null },
    pageUrl: 'https://app.example.com/myaccount/billing',
    ...overrides,
  };
}

describe('cURL export', () => {
  it('includes method, headers and body', () => {
    const curl = toCurl(make());
    expect(curl).toContain("curl -i -X POST 'https://api.example.com/v2/billing?contactId=3055861'");
    expect(curl).toContain("-H 'content-type: application/json'");
    expect(curl).toContain(`--data-raw '{"contactId":"3055861"}'`);
  });

  it('keeps redacted values redacted rather than restoring them', () => {
    expect(toCurl(make())).toContain('authorization: [REDACTED]');
  });

  it('escapes single quotes so the command stays valid', () => {
    const curl = toCurl(make({ requestBody: { encoding: 'utf8', content: `{"note":"it's fine"}`, byteLength: 20, mimeType: 'application/json', omittedReason: null } }));
    expect(curl).toContain(`'\\''`);
  });

  it('omits the body when none was captured', () => {
    expect(toCurl(make({ requestBody: null }))).not.toContain('--data-raw');
  });

  it('does not invent a body that was deliberately omitted', () => {
    const omitted = make({ requestBody: { encoding: 'omitted', content: null, byteLength: 900, mimeType: null, omittedReason: 'Too large' } });
    expect(toCurl(omitted)).not.toContain('--data-raw');
  });
});

describe('fetch snippet export', () => {
  it('produces a runnable call with method, headers and body', () => {
    const snippet = toFetchSnippet(make());
    expect(snippet).toContain('await fetch("https://api.example.com/v2/billing?contactId=3055861"');
    expect(snippet).toContain('"method": "POST"');
    expect(snippet).toContain('"body"');
  });
});

describe('tabular exports', () => {
  it('writes a CSV header and escapes commas and quotes', () => {
    const csv = toCsv([make({ error: 'Timeout, aborted' })]);
    const [header, row] = csv.split('\n');
    expect(header).toContain('method,status,durationMs');
    expect(row).toContain('"Timeout, aborted"');
  });

  it('de-duplicates the URL list', () => {
    expect(toUrlList([make(), make(), make({ url: 'https://api.example.com/v2/orders' })]).split('\n')).toHaveLength(2);
  });

  it('renders a Markdown table suitable for a defect', () => {
    const markdown = toMarkdownTable([make()]);
    expect(markdown).toContain('| Method | Path | Status |');
    expect(markdown).toContain('| POST | `/v2/billing` | 200 | 250 ms |');
  });
});

describe('HAR export', () => {
  it('produces a valid HAR 1.2 log with request and response detail', () => {
    const har = JSON.parse(toHarDocument([make()], '1.4.0'));
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toMatchObject({ name: 'ApiLens', version: '1.4.0' });
    const entry = har.log.entries[0];
    expect(entry.request.method).toBe('POST');
    expect(entry.request.queryString).toContainEqual({ name: 'contactId', value: '3055861' });
    expect(entry.request.postData.text).toContain('3055861');
    expect(entry.response.status).toBe(200);
    expect(entry.response.content.text).toContain('42.5');
    expect(entry.comment).toContain('page: https://app.example.com/myaccount/billing');
  });

  it('flags a truncated payload instead of presenting it as complete', () => {
    const har = JSON.parse(
      toHarDocument([make({ responseBody: { encoding: 'truncated', content: '{"a"', byteLength: 9000, mimeType: 'application/json', omittedReason: 'Truncated' } })], '1.4.0'),
    );
    expect(har.log.entries[0].response.content.comment).toContain('Truncated');
  });
});

describe('extract()', () => {
  it('names the file by format and label', () => {
    const result = extract([make()], 'har', { version: '1.4.0', label: 'Billing journey' });
    expect(result.filename).toMatch(/^billing-journey-.*\.har$/);
    expect(result.mime).toBe('application/json');
  });

  it('handles an empty selection without throwing', () => {
    for (const format of ['curl', 'fetch', 'json', 'csv', 'har', 'urls', 'markdown'] as const) {
      expect(() => extract([], format, { version: '1.4.0' })).not.toThrow();
    }
    expect(JSON.parse(extract([], 'har', { version: '1.4.0' }).content).log.entries).toEqual([]);
  });
});
