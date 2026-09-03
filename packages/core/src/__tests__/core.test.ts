import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesGlob, safeRegexTest } from '../glob';
import { endpointKey, isStaticAssetPath, matchesHostPattern, matchesUrlPattern, parseUrl, toPathTemplate } from '../url';
import {
  addJsonPath,
  deleteJsonPath,
  flattenJson,
  getJsonPath,
  hasJsonPath,
  nullifyJsonPath,
  parseJsonPath,
  queryJsonPath,
  setJsonPath,
} from '../json-path';
import { contentTypeOf, getHeader, isJsonMimeType, normalizeHeaders, removeHeaders } from '../headers';
import { byteLengthOf, captureBody, makeBody, parseJsonBody } from '../body';
import { createSpanId, createTraceId, hashString, shortId } from '../ids';
import { average, formatBytes, formatDuration, percentile } from '../format';

describe('glob', () => {
  it('escapes regex metacharacters in literals', () => {
    expect(matchesGlob('a.b', 'a.b')).toBe(true);
    expect(matchesGlob('axb', 'a.b')).toBe(false);
  });

  it('supports *, ** and ?', () => {
    expect(matchesGlob('/api/v1/payment', '/api/*/payment')).toBe(true);
    expect(matchesGlob('/api/v1/x/payment', '/api/**/payment')).toBe(true);
    expect(matchesGlob('/api/v1/x/payment', '/api/*/payment', { crossSegment: false })).toBe(false);
    expect(matchesGlob('cat', 'c?t')).toBe(true);
  });

  it('is case-insensitive by default', () => {
    expect(matchesGlob('HOST.example.com', 'host.*')).toBe(true);
    expect(matchesGlob('HOST.example.com', 'host.*', { caseSensitive: true })).toBe(false);
  });

  it('produces an anchored expression', () => {
    expect(globToRegExp('abc').source).toBe('^abc$');
  });

  it('never throws on invalid regex input', () => {
    expect(safeRegexTest('abc', '([')).toBe(false);
    expect(safeRegexTest('abc', 'a.c')).toBe(true);
  });
});

describe('url', () => {
  it('parses a URL into its parts', () => {
    const parsed = parseUrl('https://api.example.com:8443/orders/42?a=1&b=2#frag');
    expect(parsed.valid).toBe(true);
    expect(parsed.hostname).toBe('api.example.com');
    expect(parsed.port).toBe(8443);
    expect(parsed.path).toBe('/orders/42');
    expect(parsed.query).toEqual({ a: '1', b: '2' });
  });

  it('degrades gracefully on invalid input', () => {
    const parsed = parseUrl('not a url');
    expect(parsed.valid).toBe(false);
    expect(parsed.path).toBe('not a url');
  });

  it('collapses volatile path segments into a template', () => {
    expect(toPathTemplate('/orders/42/items')).toBe('/orders/{id}/items');
    expect(toPathTemplate('/users/8f14e45f-ea0f-4b3c-8f14-e45fce79a2b1')).toBe('/users/{uuid}');
    expect(toPathTemplate('/assets/deadbeefdeadbeef')).toBe('/assets/{hash}');
    expect(toPathTemplate('/checkout')).toBe('/checkout');
  });

  it('builds a stable endpoint key', () => {
    expect(endpointKey('get', 'api.example.com', '/orders/42')).toBe('GET api.example.com/orders/{id}');
  });

  it('treats bare patterns as contains and starred patterns as globs', () => {
    expect(matchesUrlPattern('https://a.com/api/payment', '/payment')).toBe(true);
    expect(matchesUrlPattern('https://a.com/api/payment', '*/payment')).toBe(true);
    expect(matchesUrlPattern('https://a.com/api/order', '*/payment')).toBe(false);
  });

  it('matches host patterns', () => {
    expect(matchesHostPattern('shop.qa.example.com', '*.qa.example.com')).toBe(true);
    expect(matchesHostPattern('shop.example.com', '*.qa.example.com')).toBe(false);
  });

  it('detects static asset paths', () => {
    expect(isStaticAssetPath('/static/app.js')).toBe(true);
    expect(isStaticAssetPath('/api/orders')).toBe(false);
  });
});

describe('json-path', () => {
  const sample = () => ({
    data: { items: [{ amountDue: 20, name: 'a' }, { amountDue: 30, name: 'b' }], total: 50 },
  });

  it('parses dotted, bracket and wildcard syntax', () => {
    expect(parseJsonPath('$.data.items[0].amountDue')).toEqual([
      { kind: 'key', value: 'data' },
      { kind: 'key', value: 'items' },
      { kind: 'index', value: 0 },
      { kind: 'key', value: 'amountDue' },
    ]);
    expect(parseJsonPath('a.*.b')[1]).toEqual({ kind: 'wildcard' });
  });

  it('reads values', () => {
    expect(getJsonPath(sample(), 'data.items[1].name')).toBe('b');
    expect(getJsonPath(sample(), 'data.items.0.name')).toBe('a');
    expect(getJsonPath(sample(), 'missing.path')).toBeUndefined();
  });

  it('queries wildcards', () => {
    expect(queryJsonPath(sample(), 'data.items[*].amountDue')).toEqual([20, 30]);
  });

  it('distinguishes missing keys from null values', () => {
    const value = { a: null };
    expect(hasJsonPath(value, 'a')).toBe(true);
    expect(hasJsonPath(value, 'b')).toBe(false);
    expect(getJsonPath(value, 'a')).toBeNull();
  });

  it('sets, deletes, nullifies and adds', () => {
    const target = sample();
    expect(setJsonPath(target, 'data.total', 99)).toBe(true);
    expect(target.data.total).toBe(99);

    expect(nullifyJsonPath(target, 'data.items[0].amountDue')).toBe(true);
    expect(target.data.items[0]!.amountDue).toBeNull();

    expect(deleteJsonPath(target, 'data.items[1].name')).toBe(true);
    expect('name' in target.data.items[1]!).toBe(false);

    expect(addJsonPath(target, 'data.newField', 7)).toBe(true);
    expect((target.data as unknown as Record<string, unknown>).newField).toBe(7);
  });

  it('does not overwrite an existing value with add', () => {
    const target = { a: 1 };
    addJsonPath(target, 'a', 2);
    expect(target.a).toBe(1);
  });

  it('applies wildcard mutations to every match', () => {
    const target = sample();
    nullifyJsonPath(target, 'data.items[*].amountDue');
    expect(target.data.items.map((item) => item.amountDue)).toEqual([null, null]);
  });

  it('flattens JSON into leaf paths', () => {
    const flat = flattenJson({ a: { b: [1, 2] }, c: null });
    expect(flat.get('a.b[0]')).toBe(1);
    expect(flat.get('a.b[1]')).toBe(2);
    expect(flat.get('c')).toBeNull();
  });
});

describe('headers', () => {
  it('lower-cases and stringifies', () => {
    expect(normalizeHeaders({ 'Content-Type': 'application/json', 'X-N': 5, 'X-A': ['a', 'b'] })).toEqual({
      'content-type': 'application/json',
      'x-n': '5',
      'x-a': 'a, b',
    });
  });

  it('reads case-insensitively', () => {
    expect(getHeader({ authorization: 'Bearer x' }, 'Authorization')).toBe('Bearer x');
  });

  it('removes headers', () => {
    expect(removeHeaders({ a: '1', b: '2' }, ['A'])).toEqual({ b: '2' });
  });

  it('extracts and classifies content types', () => {
    expect(contentTypeOf({ 'content-type': 'application/json; charset=utf-8' })).toBe('application/json');
    expect(isJsonMimeType('application/problem+json')).toBe(true);
    expect(isJsonMimeType('text/html')).toBe(false);
  });
});

describe('body', () => {
  it('truncates oversized payloads and records the original size', () => {
    const body = captureBody('x'.repeat(100), { maxBytes: 10, mimeType: 'application/json' });
    expect(body?.encoding).toBe('truncated');
    expect(body?.byteLength).toBe(100);
    expect(body?.content).toHaveLength(10);
  });

  it('omits binary payloads', () => {
    const body = captureBody('\u0000\u0001', { maxBytes: 1000, mimeType: 'image/png' });
    expect(body?.encoding).toBe('omitted');
    expect(body?.content).toBeNull();
  });

  it('refuses to parse truncated JSON', () => {
    const body = captureBody('{"a":1,"b":2}', { maxBytes: 5, mimeType: 'application/json' });
    expect(parseJsonBody(body).ok).toBe(false);
  });

  it('parses complete JSON bodies', () => {
    expect(parseJsonBody(makeBody('{"a":1}', 'application/json')).value).toEqual({ a: 1 });
  });

  it('measures byte length in utf-8', () => {
    expect(byteLengthOf('é')).toBe(2);
  });
});

describe('ids', () => {
  it('creates W3C-shaped trace and span ids', () => {
    expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(createSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes deterministically', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('shortens ids for display', () => {
    expect(shortId('392ae4aa-1111-2222-3333-444444444444')).toBe('392ae4');
  });
});

describe('format', () => {
  it('computes percentiles and averages', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.9)).toBe(0);
    expect(average([2, 4])).toBe(3);
  });

  it('formats durations and sizes', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(2500)).toBe('2.50s');
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
