import { describe, expect, it } from 'vitest';
import { createCapturedRequest } from '@apilens/core';
import type { CapturedRequest, RequestType } from '@apilens/shared-types';
import {
  addTerm,
  filterRequests,
  groupByPage,
  matchesQuery,
  matchesTrafficClass,
  pageKeyOf,
  parseQuery,
  removeTerm,
} from './request-query';

function make(overrides: Partial<CapturedRequest> & { url?: string; type?: RequestType } = {}): CapturedRequest {
  const base = createCapturedRequest({
    sessionId: 'qa',
    url: overrides.url ?? 'https://api.example.com/v2/billing?contactId=3055861',
    method: 'GET',
    channel: 'page-hook',
    type: overrides.type ?? 'fetch',
    startedAt: 1_000,
  });
  return {
    ...base,
    timing: { ...base.timing, completedAt: 1_250, durationMs: 250 },
    statusCode: 200,
    pageUrl: 'https://app.example.com/myaccount/billing?contactId=3055861',
    ...overrides,
  };
}

describe('query parsing', () => {
  it('treats plain words as AND and keeps quoted phrases intact', () => {
    const parsed = parseQuery('billing "order summary" account');
    expect(parsed.terms.map((term) => term.values[0])).toEqual(['billing', 'order summary', 'account']);
    expect(parsed.terms.every((term) => term.field === 'text')).toBe(true);
  });

  it('reads field prefixes, aliases and comma alternatives', () => {
    const parsed = parseQuery('status:4xx,5xx m:POST');
    expect(parsed.terms[0]).toMatchObject({ field: 'status', values: ['4xx', '5xx'], negate: false });
    expect(parsed.terms[1]).toMatchObject({ field: 'method', values: ['POST'] });
  });

  it('marks negated terms', () => {
    expect(parseQuery('-image').terms[0]).toMatchObject({ field: 'text', values: ['image'], negate: true });
    expect(parseQuery('-status:200').terms[0]).toMatchObject({ field: 'status', negate: true });
  });

  it('falls back to free text for an unknown prefix instead of dropping input', () => {
    expect(parseQuery('nonsense:value').terms[0]).toMatchObject({ field: 'text', values: ['nonsense:value'] });
  });

  it('treats an empty or whitespace query as no filter', () => {
    expect(parseQuery('   ').empty).toBe(true);
  });
});

describe('query matching', () => {
  const request = make({
    method: 'POST',
    statusCode: 503,
    serviceName: 'clear-app-bff',
    requestHeaders: { authorization: '[REDACTED]', 'content-type': 'application/json' },
    requestBody: { encoding: 'utf8', content: '{"contactId":"3055861"}', byteLength: 23, mimeType: 'application/json', omittedReason: null },
    responseBody: { encoding: 'utf8', content: '{"error":"unavailable"}', byteLength: 23, mimeType: 'application/json', omittedReason: null },
  });

  const matches = (query: string, target = request): boolean => matchesQuery(target, parseQuery(query));

  it('matches free text across url, method, status and service', () => {
    expect(matches('billing')).toBe(true);
    expect(matches('clear-app-bff')).toBe(true);
    expect(matches('nowhere')).toBe(false);
  });

  it('requires every plain term', () => {
    expect(matches('billing 503')).toBe(true);
    expect(matches('billing nowhere')).toBe(false);
  });

  it('supports status buckets, exact codes and comparisons', () => {
    expect(matches('status:5xx')).toBe(true);
    expect(matches('status:503')).toBe(true);
    expect(matches('status:404')).toBe(false);
    expect(matches('status:>=500')).toBe(true);
    expect(matches('status:<500')).toBe(false);
  });

  it('supports method, host, path and type fields', () => {
    expect(matches('method:POST')).toBe(true);
    expect(matches('method:GET')).toBe(false);
    expect(matches('host:api.example')).toBe(true);
    expect(matches('path:/v2/billing')).toBe(true);
    expect(matches('type:fetch')).toBe(true);
    expect(matches('type:static')).toBe(false);
  });

  it('searches payloads only when asked', () => {
    expect(matches('body:contactId')).toBe(true);
    expect(matches('body:unavailable')).toBe(true);
    expect(matches('body:absent')).toBe(false);
  });

  it('matches headers by name and by name=value', () => {
    expect(matches('header:authorization')).toBe(true);
    expect(matches('header:content-type=json')).toBe(true);
    expect(matches('header:content-type=xml')).toBe(false);
  });

  it('matches query-string parameters', () => {
    expect(matches('query:contactId')).toBe(true);
    expect(matches('query:contactId=3055861')).toBe(true);
    expect(matches('query:contactId=999')).toBe(false);
  });

  it('filters by failure, mock state and duration', () => {
    expect(matches('error:yes')).toBe(true);
    expect(matches('error:no')).toBe(false);
    expect(matches('mock:no')).toBe(true);
    expect(matches('slow:>100')).toBe(true);
    expect(matches('slow:>1000')).toBe(false);
  });

  it('excludes negated terms', () => {
    expect(matches('-billing')).toBe(false);
    expect(matches('-nowhere')).toBe(true);
    expect(matches('billing -status:200')).toBe(true);
  });

  it('treats comma values inside one field as OR', () => {
    expect(matches('status:404,503')).toBe(true);
    expect(matches('status:404,500')).toBe(false);
  });
});

describe('traffic class', () => {
  it('separates API calls, documents and assets', () => {
    expect(matchesTrafficClass(make({ type: 'xhr' }), 'api')).toBe(true);
    expect(matchesTrafficClass(make({ type: 'static' }), 'api')).toBe(false);
    expect(matchesTrafficClass(make({ type: 'static' }), 'assets')).toBe(true);
    expect(matchesTrafficClass(make({ type: 'navigation' }), 'documents')).toBe(true);
    expect(matchesTrafficClass(make({ type: 'static' }), 'all')).toBe(true);
  });
});

describe('page grouping', () => {
  it('keys pages by origin and path, ignoring the query string', () => {
    expect(pageKeyOf('https://app.example.com/myaccount/billing?contactId=1')).toBe('https://app.example.com/myaccount/billing');
    expect(pageKeyOf('https://app.example.com/')).toBe('https://app.example.com/');
    expect(pageKeyOf(null)).toBeNull();
    expect(pageKeyOf('chrome://extensions')).toBeNull();
  });

  it('summarises calls per page with failures and recency', () => {
    const groups = groupByPage([
      make({ pageUrl: 'https://app.example.com/a?x=1' }),
      make({ pageUrl: 'https://app.example.com/a?x=2', statusCode: 500, timing: { startedAt: 2_000, completedAt: 2_100, durationMs: 100, injectedDelayMs: null } }),
      make({ pageUrl: 'https://app.example.com/b' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ label: '/a', count: 2, errorCount: 1 });
  });
});

describe('combined filtering', () => {
  const requests = [
    make({ url: 'https://api.example.com/v2/billing', type: 'fetch' }),
    make({ url: 'https://cdn.example.com/app.js', type: 'static', pageUrl: 'https://app.example.com/myaccount/billing' }),
    make({ url: 'https://api.example.com/v2/orders', type: 'fetch', statusCode: 500, pageUrl: 'https://app.example.com/other' }),
  ];

  it('reports what each filter removed so an empty list is explainable', () => {
    const outcome = filterRequests(requests, {
      query: '',
      traffic: 'api',
      scope: { mode: 'current' },
      currentPageKey: 'https://app.example.com/myaccount/billing',
    });
    expect(outcome.requests).toHaveLength(1);
    expect(outcome.hiddenByTraffic).toBe(1);
    expect(outcome.hiddenByScope).toBe(1);
  });

  it('applies the keyword query on top of the other filters', () => {
    const outcome = filterRequests(requests, { query: 'status:5xx', traffic: 'all', scope: { mode: 'all' }, currentPageKey: null });
    expect(outcome.requests).toHaveLength(1);
    expect(outcome.hiddenByQuery).toBe(2);
  });

  it('scopes to a specific page when one is chosen', () => {
    const outcome = filterRequests(requests, {
      query: '',
      traffic: 'all',
      scope: { mode: 'page', key: 'https://app.example.com/other' },
      currentPageKey: null,
    });
    expect(outcome.requests).toHaveLength(1);
    expect(outcome.requests[0]!.url).toContain('/v2/orders');
  });
});

describe('query chip editing', () => {
  it('adds a term without duplicating it', () => {
    expect(addTerm('billing', 'status:500')).toBe('billing status:500');
    expect(addTerm('billing status:500', 'status:500')).toBe('billing status:500');
  });

  it('removes one term and re-quotes phrases that need it', () => {
    expect(removeTerm('billing status:500', 'status:500')).toBe('billing');
    expect(removeTerm('"order summary" status:500', 'status:500')).toBe('"order summary"');
  });
});
