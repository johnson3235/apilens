import { describe, expect, it } from 'vitest';
import type { PageHookStatus } from './messages';
import type { Rule } from '@apilens/shared-types';
import { isTopFrameSynchronized, revisionForRules, summariseHealth, type MockEngineHealth } from './engine-health';

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1', scenarioId: null, name: 'Payment unavailable', description: '', enabled: true, priority: 10,
    conditions: [{ field: 'url', operator: 'contains', value: '/payment' }], conditionLogic: 'and',
    action: { type: 'service-unavailable' }, applyMode: 'always', appliedCount: 0, environments: ['qa'],
    createdAt: 1, updatedAt: 2, ...overrides,
  };
}

function status(overrides: Partial<PageHookStatus> = {}): PageHookStatus {
  return {
    installed: true, fetchPatched: true, xhrPatched: true, beaconPatched: true, websocketPatched: true,
    eventSourcePatched: true, ruleCount: 1, ruleRevision: revisionForRules([rule()]), version: '1.0.0',
    updatedAt: 10_000, ...overrides,
  };
}

describe('mock engine health', () => {
  it('uses only enabled rules and changes when behavior changes', () => {
    const enabled = rule();
    expect(revisionForRules([enabled, rule({ id: 'off', enabled: false })])).toBe(revisionForRules([enabled]));
    expect(revisionForRules([enabled])).not.toBe(revisionForRules([{ ...enabled, action: { type: 'timeout' } }]));
  });

  it('requires a fresh, installed and synchronized top frame', () => {
    const expected = revisionForRules([rule()]);
    expect(isTopFrameSynchronized(status(), 1, expected, 20_000)).toBe(true);
    expect(isTopFrameSynchronized(status({ updatedAt: 0 }), 1, expected, 50_000)).toBe(false);
    expect(isTopFrameSynchronized(status({ ruleCount: 0 }), 1, expected, 20_000)).toBe(false);
    expect(isTopFrameSynchronized(status({ installed: false }), 1, expected, 20_000)).toBe(false);
  });

  it('reports the active transport honestly', () => {
    const base: MockEngineHealth = { ready: true, engine: 'page-hook', hooksInstalled: true, rulesSynced: true,
      enabledRuleCount: 1, expectedRevision: '1-x', frames: [], networkMockActive: false, lastSelfTest: null, error: null };
    expect(summariseHealth(base)).toBe('Page hooks active');
    expect(summariseHealth({ ...base, engine: 'chromium-network' })).toBe('Network interception active');
    expect(summariseHealth({ ...base, ready: false, engine: 'none', enabledRuleCount: 0 })).toBe('No rules enabled');
  });
});
