import { describe, expect, it } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import { DEFAULT_ENVIRONMENT_POLICY, type CapturedRequest, type Rule } from '@apilens/shared-types';
import { checkApplyBudget, evaluateCondition, findMatchingRule, ruleMatchesRequest } from '../matcher';
import { applyFieldMutations, executeAction, mockMarkerHeaders, requiresOriginalResponse, statusTextFor } from '../executor';
import { decideMock, describeMockingStatus, reviewImportedRules } from '../safety';
import { RULE_PRESETS, buildFieldMutationRule, exportRuleBundle, findPreset, instantiatePreset, parseRuleBundle } from '../presets';

function req(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({
      sessionId: 's1',
      url: 'https://shop.qa.example.com/api/payment?flow=card',
      method: 'POST',
      channel: 'page-hook',
    }),
    ...overrides,
  };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    scenarioId: null,
    name: 'Payment failure',
    description: '',
    enabled: true,
    priority: 10,
    conditions: [{ field: 'url', operator: 'contains', value: '/payment' }],
    conditionLogic: 'and',
    action: { type: 'status-code', statusCode: 500 },
    applyMode: 'always',
    appliedCount: 0,
    environments: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('condition matching', () => {
  it('matches URL, path, method and hostname', () => {
    const request = req();
    expect(evaluateCondition({ field: 'url', operator: 'contains', value: '/payment' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'path', operator: 'equals', value: '/api/payment' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'method', operator: 'equals', value: 'post' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'hostname', operator: 'endsWith', value: 'example.com' }, request)).toBe(true);
  });

  it('matches query parameters and headers case-insensitively', () => {
    const request = req({ requestHeaders: { 'x-channel': 'web' } });
    expect(evaluateCondition({ field: 'query', operator: 'equals', value: 'card', key: 'FLOW' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'header', operator: 'equals', value: 'web', key: 'X-Channel' }, request)).toBe(true);
  });

  it('matches request body JSONPath values', () => {
    const request = req({ requestBody: makeBody('{"payment":{"amount":250,"currency":"EUR"}}', 'application/json') });
    expect(evaluateCondition({ field: 'bodyJsonPath', operator: 'equals', value: 'EUR', key: 'payment.currency' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'bodyJsonPath', operator: 'gt', value: '100', key: 'payment.amount' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'bodyJsonPath', operator: 'exists', value: '', key: 'payment.missing' }, request)).toBe(false);
  });

  it('supports regex and glob without ever throwing', () => {
    const request = req();
    expect(evaluateCondition({ field: 'path', operator: 'regex', value: '^/api/(payment|order)$' }, request)).toBe(true);
    expect(evaluateCondition({ field: 'path', operator: 'regex', value: '([' }, request)).toBe(false);
    expect(evaluateCondition({ field: 'url', operator: 'glob', value: '*/api/payment*' }, request)).toBe(true);
  });

  it('supports negation', () => {
    expect(evaluateCondition({ field: 'method', operator: 'equals', value: 'GET', negate: true }, req())).toBe(true);
  });

  it('honours and/or logic', () => {
    const request = req();
    const andRule = rule({
      conditions: [
        { field: 'method', operator: 'equals', value: 'POST' },
        { field: 'path', operator: 'contains', value: '/order' },
      ],
    });
    expect(ruleMatchesRequest(andRule, request)).toBe(false);
    expect(ruleMatchesRequest({ ...andRule, conditionLogic: 'or' }, request)).toBe(true);
  });

  it('treats a rule with no conditions as a catch-all', () => {
    expect(ruleMatchesRequest(rule({ conditions: [] }), req())).toBe(true);
  });
});

describe('apply budgets', () => {
  it('enforces once, n-times and after-n', () => {
    expect(checkApplyBudget(rule({ applyMode: 'once', appliedCount: 1 })).eligible).toBe(false);
    expect(checkApplyBudget(rule({ applyMode: 'n-times', applyLimit: 2, appliedCount: 2 })).eligible).toBe(false);
    expect(checkApplyBudget(rule({ applyMode: 'n-times', applyLimit: 2, appliedCount: 1 })).eligible).toBe(true);
    expect(checkApplyBudget(rule({ applyMode: 'after-n', applyLimit: 3, appliedCount: 1 })).eligible).toBe(false);
    expect(checkApplyBudget(rule({ applyMode: 'after-n', applyLimit: 3, appliedCount: 3 })).eligible).toBe(true);
  });

  it('uses injectable randomness for probability', () => {
    const probabilistic = rule({ applyMode: 'probability', applyProbability: 50 });
    expect(checkApplyBudget(probabilistic, () => 0.1).eligible).toBe(true);
    expect(checkApplyBudget(probabilistic, () => 0.9).eligible).toBe(false);
  });
});

describe('rule selection', () => {
  it('picks the highest-priority match and explains skips', () => {
    const low = rule({ id: 'low', priority: 20, name: 'Low' });
    const high = rule({ id: 'high', priority: 1, name: 'High' });
    const disabled = rule({ id: 'off', priority: 0, enabled: false, name: 'Off' });

    const result = findMatchingRule([low, high, disabled], req());
    expect(result.rule?.id).toBe('high');
    expect(result.skipped.find((item) => item.ruleId === 'off')?.reason).toContain('disabled');
  });

  it('explains why nothing matched', () => {
    const result = findMatchingRule([rule({ conditions: [{ field: 'path', operator: 'equals', value: '/nope' }] })], req());
    expect(result.matched).toBe(false);
    expect(result.skipped[0]!.reason).toContain('Conditions did not match');
  });

  it('respects environment scoping', () => {
    const scoped = rule({ environments: ['dev'] });
    expect(findMatchingRule([scoped], req(), { environmentId: 'qa' }).matched).toBe(false);
    expect(findMatchingRule([scoped], req(), { environmentId: 'dev' }).matched).toBe(true);
  });
});

describe('action execution', () => {
  it('produces a structured error body for status rules', () => {
    const outcome = executeAction({ type: 'status-code', statusCode: 500 }, { ruleName: 'Payment failure' });
    expect(outcome.statusCode).toBe(500);
    expect(outcome.headers['content-type']).toBe('application/json');
    expect(JSON.parse(outcome.body)).toMatchObject({ error: { code: 500, simulated: true } });
    expect(outcome.abort).toBe(false);
  });

  it('adds protocol-correct headers for auth, rate limit and 503', () => {
    expect(executeAction({ type: 'auth-expired' }, { ruleName: 'x' }).headers['www-authenticate']).toContain('Bearer');
    expect(executeAction({ type: 'rate-limit' }, { ruleName: 'x' }).headers['retry-after']).toBe('60');
    expect(executeAction({ type: 'service-unavailable' }, { ruleName: 'x' }).statusCode).toBe(503);
  });

  it('marks transport-level failures as aborts with CDP reasons', () => {
    expect(executeAction({ type: 'timeout' }, { ruleName: 'x' })).toMatchObject({ abort: true, errorReason: 'TimedOut' });
    expect(executeAction({ type: 'connection-reset' }, { ruleName: 'x' }).errorReason).toBe('ConnectionReset');
    expect(executeAction({ type: 'dns-failure' }, { ruleName: 'x' }).errorReason).toBe('NameNotResolved');
  });

  it('produces genuinely malformed JSON', () => {
    const outcome = executeAction({ type: 'invalid-json' }, { ruleName: 'x' });
    expect(() => JSON.parse(outcome.body)).toThrow();
  });

  it('adds network-profile latency on top of the configured delay', () => {
    const outcome = executeAction({ type: 'status-code', statusCode: 200, delayMs: 100, networkProfile: 'slow-3g' }, { ruleName: 'x' });
    expect(outcome.delayMs).toBe(500);
  });

  it('flags rules that need the real response', () => {
    expect(requiresOriginalResponse({ type: 'null-field' })).toBe(true);
    expect(requiresOriginalResponse({ type: 'status-code' })).toBe(false);
    expect(executeAction({ type: 'slow-response' }, { ruleName: 'x' }).requiresOriginalResponse).toBe(true);
  });

  it('maps status codes to reason phrases', () => {
    expect(statusTextFor(503)).toBe('Service Unavailable');
    expect(statusTextFor(599)).toBe('Server Error');
  });

  it('stamps marker headers', () => {
    expect(mockMarkerHeaders('Payment failure', 'page-hook', 'status-code')['x-apilens-rule']).toBe('Payment failure');
  });
});

describe('field mutations', () => {
  const original = '{"customer":{"id":1,"email":"a@b.com"},"amountDue":20,"items":[{"price":5}]}';

  it('deletes, nullifies, sets and adds fields', () => {
    expect(JSON.parse(applyFieldMutations(original, [{ path: 'customer.email', operation: 'delete' }])).customer.email).toBeUndefined();
    expect(JSON.parse(applyFieldMutations(original, [{ path: 'amountDue', operation: 'nullify' }])).amountDue).toBeNull();
    expect(JSON.parse(applyFieldMutations(original, [{ path: 'amountDue', operation: 'set', value: 99 }])).amountDue).toBe(99);
    expect(JSON.parse(applyFieldMutations(original, [{ path: 'newField', operation: 'add', value: true }])).newField).toBe(true);
  });

  it('changes types deterministically', () => {
    expect(typeof JSON.parse(applyFieldMutations(original, [{ path: 'amountDue', operation: 'changeType' }])).amountDue).toBe('string');
    expect(
      typeof JSON.parse(applyFieldMutations(original, [{ path: 'amountDue', operation: 'changeType', targetType: 'boolean' }])).amountDue,
    ).toBe('boolean');
  });

  it('mutates every element of an array via wildcard', () => {
    const mutated = JSON.parse(applyFieldMutations(original, [{ path: 'items[*].price', operation: 'nullify' }])) as {
      items: Array<{ price: number | null }>;
    };
    expect(mutated.items.every((item) => item.price === null)).toBe(true);
  });

  it('leaves non-JSON bodies untouched instead of corrupting them', () => {
    expect(applyFieldMutations('<html>not json</html>', [{ path: 'a', operation: 'delete' }])).toBe('<html>not json</html>');
  });

  it('applies mutations through executeAction using the real response', () => {
    const outcome = executeAction(
      { type: 'null-field', fieldMutations: [{ path: 'amountDue', operation: 'nullify' }] },
      { ruleName: 'x', originalBody: original, originalStatus: 200 },
    );
    expect(JSON.parse(outcome.body).amountDue).toBeNull();
    expect(outcome.statusCode).toBe(200);
  });
});

describe('environment safety gate', () => {
  it('blocks mocking on production regardless of matching rules', () => {
    const outcome = decideMock([rule({ conditions: [] })], req({ hostname: 'www.example.com' }), DEFAULT_ENVIRONMENT_POLICY);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') expect(outcome.reason).toContain('Production');
  });

  it('blocks mocking on unclassified hosts', () => {
    expect(decideMock([rule({ conditions: [] })], req({ hostname: 'mystery-host' }), DEFAULT_ENVIRONMENT_POLICY).kind).toBe('blocked');
  });

  it('applies rules on allowed environments', () => {
    const outcome = decideMock([rule()], req(), DEFAULT_ENVIRONMENT_POLICY);
    expect(outcome.kind).toBe('apply');
    if (outcome.kind === 'apply') expect(outcome.environmentId).toBe('qa');
  });

  it('reports no-match separately from blocked', () => {
    const outcome = decideMock([rule({ conditions: [{ field: 'path', operator: 'equals', value: '/other' }] })], req(), DEFAULT_ENVIRONMENT_POLICY);
    expect(outcome.kind).toBe('no-match');
  });

  it('describes banner status', () => {
    expect(describeMockingStatus('shop.qa.example.com', [rule()], DEFAULT_ENVIRONMENT_POLICY)).toMatchObject({
      allowed: true,
      enabledRuleCount: 1,
    });
    expect(describeMockingStatus('www.example.com', [rule()], DEFAULT_ENVIRONMENT_POLICY).allowed).toBe(false);
  });

  it('rejects imported rules that target blocked hosts', () => {
    const review = reviewImportedRules(
      [
        rule({ id: 'ok', conditions: [{ field: 'hostname', operator: 'equals', value: 'shop.qa.example.com' }] }),
        rule({ id: 'bad', conditions: [{ field: 'hostname', operator: 'equals', value: 'www.example.com' }] }),
      ],
      DEFAULT_ENVIRONMENT_POLICY,
    );
    expect(review.accepted.map((item) => item.id)).toEqual(['ok']);
    expect(review.rejected[0]!.reason).toContain('www.example.com');
  });
});

describe('presets and bundles', () => {
  it('exposes a preset for every common negative scenario', () => {
    const ids = RULE_PRESETS.map((item) => item.id);
    ['server-error-500', 'auth-expired', 'forbidden', 'rate-limit', 'timeout', 'empty-response', 'invalid-json', 'slow-response'].forEach(
      (id) => expect(ids).toContain(id),
    );
  });

  it('instantiates a preset into a usable rule', () => {
    const created = instantiatePreset('server-error-500', { urlPattern: '*/payment*', method: 'POST' }, 1_000)!;
    expect(created.action).toMatchObject({ type: 'status-code', statusCode: 500 });
    expect(created.conditions).toHaveLength(2);
    expect(created.appliedCount).toBe(0);
    expect(findPreset('does-not-exist')).toBeUndefined();
    expect(instantiatePreset('does-not-exist', { urlPattern: '*' })).toBeNull();
  });

  it('builds field mutation rules', () => {
    const built = buildFieldMutationRule({ urlPattern: '*/customer*', fieldPath: 'data.email', operation: 'delete' });
    expect(built.action.type).toBe('missing-field');
    expect(built.action.fieldMutations).toEqual([{ path: 'data.email', operation: 'delete' }]);
  });

  it('round-trips a bundle and resets counters', () => {
    const bundle = exportRuleBundle('Checkout failures', 'desc', [rule({ appliedCount: 7 })]);
    expect(bundle.rules[0]!.appliedCount).toBe(0);

    const parsed = parseRuleBundle(JSON.stringify(bundle));
    expect(parsed.error).toBeNull();
    expect(parsed.bundle?.rules).toHaveLength(1);
  });

  it('imports rules disabled so nothing fires on open', () => {
    const parsed = parseRuleBundle(JSON.stringify(exportRuleBundle('b', '', [rule({ enabled: true })])));
    expect(parsed.bundle?.rules[0]!.enabled).toBe(false);
  });

  it('accepts a bare rule array for backwards compatibility', () => {
    expect(parseRuleBundle(JSON.stringify([rule()])).bundle?.rules).toHaveLength(1);
  });

  it('reports parse failures instead of throwing', () => {
    expect(parseRuleBundle('{oops').error).not.toBeNull();
    expect(parseRuleBundle('{"rules":[]}').error).toContain('no valid rules');
    expect(parseRuleBundle('{"nope":1}').error).toContain('rules');
  });
});
