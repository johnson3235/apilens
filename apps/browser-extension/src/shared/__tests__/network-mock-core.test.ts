import { describe, expect, it } from 'vitest';
import type { CapturedRequest, Rule } from '@apilens/shared-types';
import { decideNetworkMock } from '../network-mock-core';

const request: CapturedRequest = {
  id: 'network-request', sessionId: '', source: 'browser', type: 'fetch', method: 'GET',
  url: 'https://example.test/api/checkout', path: '/api/checkout', hostname: 'example.test',
  queryParams: {}, requestHeaders: {}, responseHeaders: {}, requestBody: null, responseBody: null,
  statusCode: null, durationMs: null, startedAt: 0, completedAt: null, traceId: null, spanId: null,
  parentSpanId: null, serviceName: null, scenarioApplied: null, error: null, isClientSide: true,
  graphqlOperation: null, graphqlOperationType: null
};

function rule(action: Rule['action']): Rule {
  return {
    id: 'network-rule', scenarioId: 'network', name: 'Force checkout failure', description: '', enabled: true,
    priority: 1, conditions: [{ field: 'path', operator: 'equals', value: '/api/checkout' }],
    conditionLogic: 'and', action, applyMode: 'always', appliedCount: 0, createdAt: 0, updatedAt: 0
  };
}

describe('network mock decision', () => {
  it('fulfills a matching request with the forced response before it reaches the server', () => {
    const result = decideNetworkMock([rule({ type: 'status-code', statusCode: 503, responseBody: '{"forced":true}' })], request);
    expect(result.kind).toBe('fulfill');
    if (result.kind !== 'fulfill') return;
    expect(result.statusCode).toBe(503);
    expect(result.body).toBe('{"forced":true}');
    expect(result.headers['x-apilens-mocked-from']).toBe('ApiLens');
  });

  it('fails a matching request without contacting the server for connection-reset rules', () => {
    const result = decideNetworkMock([rule({ type: 'connection-reset' })], request);
    expect(result).toMatchObject({ kind: 'fail', errorReason: 'ConnectionReset' });
  });

  it('uses a valid browser network error for timeout rules', () => {
    const result = decideNetworkMock([rule({ type: 'timeout' })], request);
    expect(result).toMatchObject({ kind: 'fail', errorReason: 'TimedOut' });
  });

  it('does not fake a response for a rule that needs the real response body', () => {
    const result = decideNetworkMock([rule({ type: 'missing-field', modifyField: { path: 'data.id', operation: 'delete', value: null } })], request);
    expect(result.kind).toBe('continue');
  });

  it('leaves slow-response rules with the page engine so the original response remains intact', () => {
    const result = decideNetworkMock([rule({ type: 'slow-response', delayMs: 500 })], request);
    expect(result.kind).toBe('continue');
  });
});
