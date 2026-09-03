import { describe, expect, it } from 'vitest';
import type { CapturedRequest } from '@apilens/shared-types';
import { buildCustomMockAction, findRequestCandidates } from './mock-builder';

function request(id: string, method: string, url: string, statusCode = 200): CapturedRequest {
  const parsed = new URL(url);
  return {
    id,
    method,
    url,
    path: parsed.pathname,
    hostname: parsed.hostname,
    statusCode,
    type: 'fetch',
  } as CapturedRequest;
}

describe('mock request search', () => {
  const requests = [
    request('1', 'GET', 'https://shop.test/api/products'),
    request('2', 'POST', 'https://shop.test/api/checkout-session', 201),
    request('3', 'PATCH', 'https://shop.test/api/update-journey'),
  ];

  it('combines two keywords with AND', () => {
    expect(findRequestCandidates(requests, ['post', 'checkout'], 'and').map((item) => item.id)).toEqual(['2']);
    expect(findRequestCandidates(requests, ['post', 'products'], 'and')).toEqual([]);
  });

  it('combines two keywords with OR and ignores an empty keyword', () => {
    expect(findRequestCandidates(requests, ['products', 'journey'], 'or').map((item) => item.id)).toEqual(['3', '1']);
    expect(findRequestCandidates(requests, ['', 'checkout'], 'and').map((item) => item.id)).toEqual(['2']);
  });

  it('keeps only the newest observation of the same API', () => {
    const repeated = [...requests, request('4', 'GET', 'https://shop.test/api/products', 503)];
    expect(findRequestCandidates(repeated, ['products'], 'and').map((item) => item.id)).toEqual(['4']);
  });
});

describe('custom mock response', () => {
  it('creates a custom status, body and content type', () => {
    expect(buildCustomMockAction({ statusCode: '422', responseBody: '{"code":"INVALID"}', contentType: 'application/json' }))
      .toEqual({
        type: 'status-code',
        statusCode: 422,
        responseBody: '{"code":"INVALID"}',
        responseHeaders: { 'content-type': 'application/json' },
      });
  });

  it('rejects unsafe or invalid status values', () => {
    expect(() => buildCustomMockAction({ statusCode: '99', responseBody: '', contentType: 'text/plain' })).toThrow(/200 to 599/);
    expect(() => buildCustomMockAction({ statusCode: '500.5', responseBody: '', contentType: 'text/plain' })).toThrow(/200 to 599/);
  });
});
