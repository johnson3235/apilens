import { describe, expect, it } from 'vitest';
import type { Rule } from '@apilens/shared-types';
import { isTopFrameSynchronized, revisionForRules } from '../interceptor-health';

function rule(path: string, appliedCount = 0): Rule {
  return {
    id: `rule-${path}`,
    scenarioId: 'health-regression',
    name: `Mock ${path}`,
    description: 'Health handshake regression coverage',
    enabled: true,
    priority: 1,
    conditions: [{ field: 'url', operator: 'contains', value: path }],
    conditionLogic: 'and',
    action: { type: 'status-code', statusCode: 503 },
    applyMode: 'always',
    appliedCount,
    createdAt: 1,
    updatedAt: 1
  };
}

describe('interceptor health handshake', () => {
  it('changes revision when a same-count rule set changes', () => {
    expect(revisionForRules([rule('/api/one')])).not.toBe(revisionForRules([rule('/api/two')]));
  });

  it('does not change revision for applied-count telemetry', () => {
    expect(revisionForRules([rule('/api/one', 0)])).toBe(revisionForRules([rule('/api/one', 99)]));
  });

  it('requires hooks, count, and exact revision before reporting synchronized', () => {
    const status = {
      installed: true,
      fetchPatched: true,
      xhrPatched: true,
      ruleCount: 1,
      rulesRevision: 'current'
    };

    expect(isTopFrameSynchronized(status, 1, 'current')).toBe(true);
    expect(isTopFrameSynchronized(status, 1, 'stale')).toBe(false);
    expect(isTopFrameSynchronized({ ...status, fetchPatched: false }, 1, 'current')).toBe(false);
  });
});
