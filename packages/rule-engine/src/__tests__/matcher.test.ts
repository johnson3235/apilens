import { describe, it, expect, beforeEach } from 'vitest';
import { RuleMatcher } from '../matcher';
import { Rule, CapturedRequest, MatchCondition } from '@apilens/shared-types';

describe('RuleMatcher', () => {
  let matcher: RuleMatcher;

  beforeEach(() => {
    matcher = new RuleMatcher();
  });

  const createMockRequest = (overrides: Partial<CapturedRequest> = {}): CapturedRequest => ({
    id: 'req-1',
    sessionId: 'sess-1',
    source: 'browser',
    type: 'fetch',
    method: 'GET',
    url: 'https://api.example.com/users/123',
    path: '/users/123',
    hostname: 'api.example.com',
    queryParams: {},
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    statusCode: 200,
    durationMs: 50,
    startedAt: Date.now(),
    completedAt: Date.now() + 50,
    traceId: null,
    spanId: null,
    parentSpanId: null,
    serviceName: 'user-service',
    scenarioApplied: null,
    error: null,
    isClientSide: true,
    graphqlOperation: null,
    graphqlOperationType: null,
    ...overrides
  });

  const createMockRule = (overrides: Partial<Rule> = {}): Rule => ({
    id: 'rule-1',
    scenarioId: 'scen-1',
    name: 'Test Rule',
    description: 'A test rule',
    enabled: true,
    priority: 10,
    conditions: [],
    conditionLogic: 'and',
    action: { type: 'status-code', statusCode: 500 },
    applyMode: 'always',
    appliedCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  });

  it('evaluates URL exact match', () => {
    const req = createMockRequest({ url: 'https://test.com/api' });
    const cond: MatchCondition = { field: 'url', operator: 'equals', value: 'https://test.com/api' };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
    
    cond.value = 'https://test.com/api/';
    expect(matcher.evaluateCondition(cond, req)).toBe(false);
  });

  it('evaluates Path contains match', () => {
    const req = createMockRequest({ path: '/api/v1/users' });
    const cond: MatchCondition = { field: 'path', operator: 'contains', value: 'v1/users' };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
  });

  it('evaluates Method equals match', () => {
    const req = createMockRequest({ method: 'POST' });
    const cond: MatchCondition = { field: 'method', operator: 'equals', value: 'POST' };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
  });

  it('evaluates Regex URL match', () => {
    const req = createMockRequest({ url: 'https://api.example.com/users/42' });
    const cond: MatchCondition = { field: 'url', operator: 'regex', value: '.*\\/users\\/\\d+' };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
  });

  it('evaluates Header exists and notExists', () => {
    const req = createMockRequest({ requestHeaders: { 'Authorization': 'Bearer token' } });
    
    const condExists: MatchCondition = { field: 'header', key: 'Authorization', operator: 'exists', value: '' };
    expect(matcher.evaluateCondition(condExists, req)).toBe(true);
    
    const condNotExists: MatchCondition = { field: 'header', key: 'X-Custom', operator: 'notExists', value: '' };
    expect(matcher.evaluateCondition(condNotExists, req)).toBe(true);
  });

  it('evaluates Query parameter match', () => {
    const req = createMockRequest({ queryParams: { 'id': '100', 'sort': 'desc' } });
    const cond: MatchCondition = { field: 'query', key: 'id', operator: 'equals', value: '100' };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
  });

  it('evaluates GraphQL operation match', () => {
    const req = createMockRequest({ graphqlOperation: 'GetUser' });
    const cond: MatchCondition = { field: 'graphqlOperation', operator: 'equals', value: 'GetUser' };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
  });

  it('evaluates AND condition logic', () => {
    const req = createMockRequest({ method: 'GET', path: '/users' });
    const rule = createMockRule({
      conditionLogic: 'and',
      conditions: [
        { field: 'method', operator: 'equals', value: 'GET' },
        { field: 'path', operator: 'equals', value: '/users' }
      ]
    });
    expect(matcher.evaluateRule(rule, req)).toBe(true);
    
    rule.conditions[1].value = '/posts';
    expect(matcher.evaluateRule(rule, req)).toBe(false);
  });

  it('evaluates OR condition logic', () => {
    const req = createMockRequest({ method: 'GET', path: '/users' });
    const rule = createMockRule({
      conditionLogic: 'or',
      conditions: [
        { field: 'method', operator: 'equals', value: 'POST' },
        { field: 'path', operator: 'equals', value: '/users' }
      ]
    });
    expect(matcher.evaluateRule(rule, req)).toBe(true);
  });

  it('skips disabled rules', () => {
    const req = createMockRequest();
    const rule = createMockRule({ enabled: false });
    const result = matcher.findMatchingRule([rule], req);
    expect(result.matched).toBe(false);
  });

  it('respects priority ordering', () => {
    const req = createMockRequest({ method: 'GET' });
    const rule1 = createMockRule({ id: 'r1', priority: 20, conditions: [{ field: 'method', operator: 'equals', value: 'GET' }] });
    const rule2 = createMockRule({ id: 'r2', priority: 10, conditions: [{ field: 'method', operator: 'equals', value: 'GET' }] });
    
    const result = matcher.findMatchingRule([rule1, rule2], req);
    expect(result.matched).toBe(true);
    expect(result.rule?.id).toBe('r2');
  });

  it('handles apply once mode', () => {
    const req = createMockRequest();
    const rule = createMockRule({ applyMode: 'once', appliedCount: 1 });
    expect(matcher.evaluateRule(rule, req)).toBe(false);
    
    rule.appliedCount = 0;
    expect(matcher.evaluateRule(rule, req)).toBe(true);
  });

  it('handles apply n-times mode', () => {
    const req = createMockRequest();
    const rule = createMockRule({ applyMode: 'n-times', applyLimit: 3, appliedCount: 3 });
    expect(matcher.evaluateRule(rule, req)).toBe(false);
    
    rule.appliedCount = 2;
    expect(matcher.evaluateRule(rule, req)).toBe(true);
  });

  it('handles probability mode', () => {
    const req = createMockRequest();
    const rule = createMockRule({ applyMode: 'probability', applyProbability: 100 });
    expect(matcher.evaluateRule(rule, req)).toBe(true);
    
    rule.applyProbability = 0;
    expect(matcher.evaluateRule(rule, req)).toBe(false);
  });

  it('evaluates case insensitive matching', () => {
    const req = createMockRequest({ path: '/API/USERS' });
    const cond: MatchCondition = { field: 'path', operator: 'equals', value: '/api/users', caseSensitive: false };
    expect(matcher.evaluateCondition(cond, req)).toBe(true);
    
    cond.caseSensitive = true;
    expect(matcher.evaluateCondition(cond, req)).toBe(false);
  });

  it('returns false when no matching rule found', () => {
    const req = createMockRequest({ method: 'POST' });
    const rule = createMockRule({ conditions: [{ field: 'method', operator: 'equals', value: 'GET' }] });
    const result = matcher.findMatchingRule([rule], req);
    expect(result.matched).toBe(false);
    expect(result.rule).toBeNull();
  });
});
