import { describe, expect, it } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import type { CapturedRequest, ContractSet, JsonSchema, ResponseAssertion } from '@apilens/shared-types';
import { findBinding, pathMatchesTemplate, validateAgainstSchema } from '../schema';
import { importJsonSchema, importOpenApi, inferSchema } from '../openapi';
import { runAssertions, runAssertionsForSession, validateResponse, validateSession } from '../assertions';

const orderSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'status', 'amountDue'],
  properties: {
    id: { type: 'integer' },
    status: { type: 'string', enum: ['ACTIVE', 'CLOSED'] },
    amountDue: { type: 'number' },
    email: { type: 'string', format: 'email' },
    items: { type: 'array', items: { type: 'object', required: ['sku'], properties: { sku: { type: 'string' } } } },
  },
  additionalProperties: false,
};

function req(body: string, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({ sessionId: 's', url: 'https://api.example.com/orders/42', method: 'GET', channel: 'page-hook' }),
    statusCode: 200,
    timing: { startedAt: 0, completedAt: 120, durationMs: 120, injectedDelayMs: null },
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: makeBody(body, 'application/json'),
    ...overrides,
  };
}

describe('schema validation', () => {
  it('accepts a conforming payload', () => {
    const result = validateAgainstSchema({ id: 1, status: 'ACTIVE', amountDue: 20 }, orderSchema);
    expect(result.valid).toBe(true);
  });

  it('reports missing required properties', () => {
    const result = validateAgainstSchema({ id: 1, status: 'ACTIVE' }, orderSchema);
    expect(result.violations[0]).toMatchObject({ kind: 'missing-property', path: 'amountDue' });
  });

  it('reports wrong types with the actual type', () => {
    const result = validateAgainstSchema({ id: '1', status: 'ACTIVE', amountDue: 20 }, orderSchema);
    expect(result.violations[0]).toMatchObject({ kind: 'wrong-type', expected: 'integer', actual: 'string' });
  });

  it('distinguishes a nullable mismatch from a type mismatch', () => {
    const result = validateAgainstSchema({ id: 1, status: 'ACTIVE', amountDue: null }, orderSchema);
    expect(result.violations[0]!.kind).toBe('nullable-mismatch');
  });

  it('allows null when nullable is declared', () => {
    const result = validateAgainstSchema({ a: null }, { type: 'object', properties: { a: { type: 'string', nullable: true } } });
    expect(result.valid).toBe(true);
  });

  it('reports unexpected properties when additionalProperties is false', () => {
    const result = validateAgainstSchema({ id: 1, status: 'ACTIVE', amountDue: 20, extra: true }, orderSchema);
    expect(result.violations[0]).toMatchObject({ kind: 'unexpected-property', path: 'extra' });
  });

  it('validates enums and formats', () => {
    expect(validateAgainstSchema({ id: 1, status: 'UNKNOWN', amountDue: 1 }, orderSchema).violations[0]!.kind).toBe('enum-mismatch');
    expect(validateAgainstSchema({ id: 1, status: 'ACTIVE', amountDue: 1, email: 'nope' }, orderSchema).violations[0]!.kind).toBe(
      'format-mismatch',
    );
  });

  it('validates array items with their own paths', () => {
    const result = validateAgainstSchema({ id: 1, status: 'ACTIVE', amountDue: 1, items: [{ sku: 'a' }, {}] }, orderSchema);
    expect(result.violations[0]!.path).toBe('items[1].sku');
  });

  it('resolves $ref against component definitions', () => {
    const schema: JsonSchema = { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } };
    const result = validateAgainstSchema({ order: { id: 'bad', status: 'ACTIVE', amountDue: 1 } }, schema, { Order: orderSchema });
    expect(result.violations[0]!.path).toBe('order.id');
  });

  it('accepts a value satisfying any oneOf alternative', () => {
    const schema: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateAgainstSchema(5, schema).valid).toBe(true);
    expect(validateAgainstSchema(true, schema).valid).toBe(false);
  });

  it('accepts integers where a number is expected', () => {
    expect(validateAgainstSchema({ id: 1, status: 'ACTIVE', amountDue: 20 }, orderSchema).valid).toBe(true);
  });
});

describe('contract binding', () => {
  const contract: ContractSet = {
    id: 'c1',
    name: 'Orders API',
    sourceFormat: 'json-schema',
    definitions: {},
    importedAt: 0,
    bindings: [
      { id: 'b1', name: 'Get order', method: 'GET', pathTemplate: '/orders/{id}', hostPattern: 'api.example.com', statusCode: null, schema: orderSchema, enabled: true },
    ],
  };

  it('matches templated paths', () => {
    expect(pathMatchesTemplate('/orders/42', '/orders/{id}')).toBe(true);
    expect(pathMatchesTemplate('/orders/42/items', '/orders/{id}')).toBe(false);
    expect(pathMatchesTemplate('/customers/42', '/orders/{id}')).toBe(false);
  });

  it('finds the applicable binding for a 2xx response', () => {
    expect(findBinding([contract], 'GET', 'api.example.com', '/orders/42', 200)).not.toBeNull();
    expect(findBinding([contract], 'GET', 'api.example.com', '/orders/42', 500)).toBeNull();
    expect(findBinding([contract], 'POST', 'api.example.com', '/orders/42', 200)).toBeNull();
  });

  it('skips validation transparently when no binding matches', () => {
    const result = validateResponse(req('{"id":1}', { path: '/unknown' }), [contract]);
    expect(result.skippedReason).toContain('No contract binding');
  });

  it('validates a real captured response', () => {
    expect(validateResponse(req('{"id":1,"status":"ACTIVE","amountDue":20}'), [contract]).valid).toBe(true);
    const invalid = validateResponse(req('{"id":1,"status":"ACTIVE","amountDue":null}'), [contract]);
    expect(invalid.valid).toBe(false);
    expect(invalid.violations[0]!.message).toContain('amountDue');
  });

  it('validates a whole session and omits skipped entries', () => {
    const results = validateSession([req('{"id":1,"status":"ACTIVE","amountDue":20}'), req('{}', { path: '/other' })], [contract]);
    expect(results).toHaveLength(1);
  });
});

describe('OpenAPI import', () => {
  const document = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Checkout API' },
    servers: [{ url: 'https://api.example.com/v1' }],
    components: { schemas: { Order: orderSchema } },
    paths: {
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
        },
      },
    },
  });

  it('extracts response bindings and definitions', () => {
    const { contract, error } = importOpenApi(document);
    expect(error).toBeNull();
    expect(contract?.name).toBe('Checkout API');
    expect(contract?.bindings[0]).toMatchObject({ method: 'GET', pathTemplate: '/orders/{id}', statusCode: 200, hostPattern: 'api.example.com' });
    expect(contract?.definitions.Order).toBeDefined();
  });

  it('validates through the imported $ref', () => {
    const { contract } = importOpenApi(document);
    const result = validateResponse(req('{"id":"nope","status":"ACTIVE","amountDue":1}'), [contract!]);
    expect(result.valid).toBe(false);
  });

  it('reports import failures clearly', () => {
    expect(importOpenApi('{bad').error).toContain('not valid JSON');
    expect(importOpenApi('{"info":{}}').error).toContain('paths');
    expect(importOpenApi('{"paths":{"/a":{"get":{"responses":{}}}}}').error).toContain('No JSON response schemas');
  });

  it('imports a standalone JSON Schema', () => {
    const { contract } = importJsonSchema(JSON.stringify(orderSchema), {
      name: 'Order',
      method: 'GET',
      pathTemplate: '/orders/{id}',
      hostPattern: 'api.example.com',
      statusCode: 200,
    });
    expect(contract?.bindings).toHaveLength(1);
  });

  it('infers a schema from an observed payload', () => {
    const schema = inferSchema({ id: 1, name: 'a', tags: ['x'], nested: { ok: true } });
    expect(schema.properties?.id?.type).toBe('integer');
    expect(schema.properties?.tags?.type).toBe('array');
    expect(schema.properties?.nested?.properties?.ok?.type).toBe('boolean');
  });
});

describe('assertions', () => {
  const assertions: ResponseAssertion[] = [
    { id: 'a1', name: 'Status is 200', urlPattern: '/orders', method: 'ANY', target: 'status', key: null, operator: 'equals', expected: '200', enabled: true },
    { id: 'a2', name: 'Status field is ACTIVE', urlPattern: '/orders', method: 'GET', target: 'bodyJsonPath', key: '$.status', operator: 'equals', expected: 'ACTIVE', enabled: true },
    { id: 'a3', name: 'Email is present', urlPattern: '/orders', method: 'ANY', target: 'bodyJsonPath', key: 'email', operator: 'notNull', expected: '', enabled: true },
    { id: 'a4', name: 'Responds under 500ms', urlPattern: '/orders', method: 'ANY', target: 'durationMs', key: null, operator: 'lessThan', expected: '500', enabled: true },
    { id: 'a5', name: 'JSON content type', urlPattern: '/orders', method: 'ANY', target: 'header', key: 'content-type', operator: 'contains', expected: 'json', enabled: true },
    { id: 'a6', name: 'Disabled check', urlPattern: '/orders', method: 'ANY', target: 'status', key: null, operator: 'equals', expected: '999', enabled: false },
  ];

  it('passes when every expectation holds', () => {
    const results = runAssertions(assertions, req('{"status":"ACTIVE","email":"a@b.com"}'));
    expect(results).toHaveLength(5);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('fails with an actionable message', () => {
    const results = runAssertions(assertions, req('{"status":"CLOSED","email":null}'));
    const statusCheck = results.find((result) => result.assertionId === 'a2')!;
    expect(statusCheck.passed).toBe(false);
    expect(statusCheck.message).toContain('expected bodyJsonPath "$.status" equals ACTIVE, got CLOSED');

    expect(results.find((result) => result.assertionId === 'a3')!.passed).toBe(false);
  });

  it('skips assertions that do not apply', () => {
    expect(runAssertions(assertions, req('{}', { url: 'https://api.example.com/customer', path: '/customer' }))).toHaveLength(0);
    expect(runAssertions(assertions, req('{}', { method: 'POST' })).map((result) => result.assertionId)).not.toContain('a2');
  });

  it('handles exists, matches and typeIs operators', () => {
    const custom: ResponseAssertion[] = [
      { id: 'c1', name: 'has id', urlPattern: '/orders', method: 'ANY', target: 'bodyJsonPath', key: 'id', operator: 'exists', expected: '', enabled: true },
      { id: 'c2', name: 'id is number', urlPattern: '/orders', method: 'ANY', target: 'bodyJsonPath', key: 'id', operator: 'typeIs', expected: 'number', enabled: true },
      { id: 'c3', name: 'ref matches', urlPattern: '/orders', method: 'ANY', target: 'bodyJsonPath', key: 'ref', operator: 'matches', expected: '^ORD-\\d+$', enabled: true },
    ];
    const results = runAssertions(custom, req('{"id":7,"ref":"ORD-99"}'));
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('does not throw on an unparsable body', () => {
    const results = runAssertions(assertions, req('<html>', { responseBody: makeBody('<html>', 'text/html') }));
    expect(results.find((result) => result.assertionId === 'a2')!.passed).toBe(false);
  });

  it('summarises a session run', () => {
    const report = runAssertionsForSession(assertions, [req('{"status":"ACTIVE","email":"a@b.com"}'), req('{"status":"CLOSED","email":null}')]);
    expect(report.passedCount).toBe(8);
    expect(report.failedCount).toBe(2);
  });
});
