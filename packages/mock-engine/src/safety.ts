import type { CapturedRequest, EnvironmentPolicy, Rule, RuleEvaluationResult } from '@apilens/shared-types';
import { canMock } from '@apilens/core';
import { findMatchingRule, type MatchOptions } from './matcher';

export type MockGateOutcome =
  | { kind: 'blocked'; reason: string; environmentId: string; environmentName: string }
  | { kind: 'no-match'; evaluation: RuleEvaluationResult; environmentId: string }
  | {
      kind: 'apply';
      rule: Rule;
      evaluation: RuleEvaluationResult;
      environmentId: string;
      viaOverride: boolean;
    };

/**
 * The mandatory entry point for every mocking decision.
 *
 * Environment safety is evaluated **before** rules, so it is impossible for a
 * matching rule to fire against a blocked environment no matter which
 * transport calls in.
 */
export function decideMock(
  rules: Rule[],
  request: CapturedRequest,
  policy: EnvironmentPolicy,
  options: MatchOptions = {},
  now = Date.now(),
): MockGateOutcome {
  const gate = canMock(request.hostname, policy, now);

  if (!gate.allowed) {
    return {
      kind: 'blocked',
      reason: gate.reason,
      environmentId: gate.environment.id,
      environmentName: gate.environment.name,
    };
  }

  const evaluation = findMatchingRule(rules, request, {
    ...options,
    environmentId: options.environmentId ?? gate.environment.id,
  });

  if (!evaluation.matched || !evaluation.rule) {
    return { kind: 'no-match', evaluation, environmentId: gate.environment.id };
  }

  return {
    kind: 'apply',
    rule: evaluation.rule,
    evaluation,
    environmentId: gate.environment.id,
    viaOverride: gate.viaOverride,
  };
}

export interface MockingStatus {
  environmentId: string;
  environmentName: string;
  allowed: boolean;
  viaOverride: boolean;
  reason: string | null;
  enabledRuleCount: number;
}

/** Drives the persistent `MOCK ACTIVE` / `MOCKING BLOCKED` banner. */
export function describeMockingStatus(
  hostname: string,
  rules: Rule[],
  policy: EnvironmentPolicy,
  now = Date.now(),
): MockingStatus {
  const gate = canMock(hostname, policy, now);
  const enabledRuleCount = rules.filter((rule) => rule.enabled).length;
  if (!gate.allowed) {
    return {
      environmentId: gate.environment.id,
      environmentName: gate.environment.name,
      allowed: false,
      viaOverride: false,
      reason: gate.reason,
      enabledRuleCount,
    };
  }
  return {
    environmentId: gate.environment.id,
    environmentName: gate.environment.name,
    allowed: true,
    viaOverride: gate.viaOverride,
    reason: null,
    enabledRuleCount,
  };
}

/**
 * Refuses to import rules that target hosts the current policy forbids.
 * Shared mock bundles are a common way to accidentally point a production host
 * at a failure injection rule.
 */
export interface RuleImportReview {
  accepted: Rule[];
  rejected: Array<{ rule: Rule; reason: string }>;
}

export function reviewImportedRules(rules: Rule[], policy: EnvironmentPolicy, now = Date.now()): RuleImportReview {
  const accepted: Rule[] = [];
  const rejected: Array<{ rule: Rule; reason: string }> = [];

  rules.forEach((rule) => {
    const hostConditions = rule.conditions.filter((condition) => condition.field === 'hostname');
    const blockedHost = hostConditions.find((condition) => {
      const decision = canMock(condition.value, policy, now);
      return !decision.allowed;
    });

    if (blockedHost) {
      rejected.push({
        rule,
        reason: `Rule targets host "${blockedHost.value}", which the current environment policy does not allow mocking on.`,
      });
      return;
    }
    accepted.push(rule);
  });

  return { accepted, rejected };
}
