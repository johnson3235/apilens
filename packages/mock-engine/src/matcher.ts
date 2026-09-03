import type { CapturedRequest, MatchCondition, Rule, RuleEvaluationResult } from '@apilens/shared-types';
import { getHeader, matchesGlob, parseJsonBody, queryJsonPath, safeRegexTest } from '@apilens/core';

function resolveTarget(condition: MatchCondition, request: CapturedRequest): string | undefined {
  switch (condition.field) {
    case 'url':
      return request.url;
    case 'path':
      return request.path;
    case 'method':
      return request.method;
    case 'hostname':
      return request.hostname;
    case 'port':
      return request.port === null ? undefined : String(request.port);
    case 'environment':
      return request.environmentId ?? undefined;
    case 'serviceName':
      return request.serviceName ?? undefined;
    case 'statusCode':
      return request.statusCode === null ? undefined : String(request.statusCode);
    case 'graphqlOperation':
      return request.graphql?.operationName ?? undefined;
    case 'body':
      return request.requestBody?.content ?? undefined;
    case 'query': {
      if (!condition.key) return undefined;
      const key = Object.keys(request.queryParams).find(
        (name) => name.toLowerCase() === condition.key!.toLowerCase(),
      );
      return key ? request.queryParams[key] : undefined;
    }
    case 'header': {
      if (!condition.key) return undefined;
      return getHeader(request.requestHeaders, condition.key);
    }
    case 'bodyJsonPath': {
      if (!condition.key) return undefined;
      const parsed = parseJsonBody(request.requestBody);
      if (!parsed.ok) return undefined;
      const matches = queryJsonPath(parsed.value, condition.key);
      if (matches.length === 0) return undefined;
      const first = matches[0];
      if (first === null) return 'null';
      return typeof first === 'object' ? JSON.stringify(first) : String(first);
    }
    default:
      return undefined;
  }
}

function compare(condition: MatchCondition, rawTarget: string | undefined): boolean {
  if (condition.operator === 'exists') return rawTarget !== undefined;
  if (condition.operator === 'notExists') return rawTarget === undefined;
  if (rawTarget === undefined) return false;

  if (condition.operator === 'gt' || condition.operator === 'lt') {
    const left = Number(rawTarget);
    const right = Number(condition.value);
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    return condition.operator === 'gt' ? left > right : left < right;
  }

  if (condition.operator === 'regex') {
    return safeRegexTest(rawTarget, condition.value, condition.caseSensitive ? '' : 'i');
  }

  if (condition.operator === 'glob') {
    return matchesGlob(rawTarget, condition.value, { caseSensitive: condition.caseSensitive ?? false });
  }

  const target = condition.caseSensitive ? rawTarget : rawTarget.toLowerCase();
  const expected = condition.caseSensitive ? condition.value : condition.value.toLowerCase();

  switch (condition.operator) {
    case 'equals':
      return target === expected;
    case 'contains':
      return target.includes(expected);
    case 'startsWith':
      return target.startsWith(expected);
    case 'endsWith':
      return target.endsWith(expected);
    default:
      return false;
  }
}

export function evaluateCondition(condition: MatchCondition, request: CapturedRequest): boolean {
  const result = compare(condition, resolveTarget(condition, request));
  return condition.negate ? !result : result;
}

export interface RuleGateResult {
  eligible: boolean;
  reason: string;
}

/**
 * Checks apply-mode budgets. Kept separate from condition matching so the UI
 * can explain "rule matched but its budget is exhausted".
 */
export function checkApplyBudget(rule: Rule, random: () => number = Math.random): RuleGateResult {
  switch (rule.applyMode) {
    case 'once':
      return rule.appliedCount >= 1
        ? { eligible: false, reason: 'Rule is set to apply once and has already fired.' }
        : { eligible: true, reason: '' };
    case 'n-times': {
      const limit = rule.applyLimit ?? 1;
      return rule.appliedCount >= limit
        ? { eligible: false, reason: `Rule reached its limit of ${limit} applications.` }
        : { eligible: true, reason: '' };
    }
    case 'after-n': {
      const skip = rule.applyLimit ?? 0;
      return rule.appliedCount < skip
        ? { eligible: false, reason: `Rule starts applying after ${skip} matching calls.` }
        : { eligible: true, reason: '' };
    }
    case 'probability': {
      const probability = rule.applyProbability ?? 100;
      return random() * 100 >= probability
        ? { eligible: false, reason: `Probabilistic rule (${probability}%) did not fire this time.` }
        : { eligible: true, reason: '' };
    }
    case 'always':
    default:
      return { eligible: true, reason: '' };
  }
}

export function ruleMatchesRequest(rule: Rule, request: CapturedRequest): boolean {
  if (rule.conditions.length === 0) return true;
  const results = rule.conditions.map((condition) => evaluateCondition(condition, request));
  return rule.conditionLogic === 'or' ? results.some(Boolean) : results.every(Boolean);
}

export interface MatchOptions {
  /** Injectable randomness so probabilistic rules are testable. */
  random?: () => number;
  /** Restrict matching to rules valid for this environment. */
  environmentId?: string | null;
}

/**
 * Finds the highest-priority enabled rule that matches, recording *why* each
 * candidate was skipped. The explanation is what turns "my mock didn't fire"
 * from a mystery into a two-second diagnosis.
 */
export function findMatchingRule(
  rules: Rule[],
  request: CapturedRequest,
  options: MatchOptions = {},
): RuleEvaluationResult {
  const random = options.random ?? Math.random;
  const skipped: RuleEvaluationResult['skipped'] = [];
  const ordered = [...rules].sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt);

  for (const rule of ordered) {
    if (!rule.enabled) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: 'Rule is disabled.' });
      continue;
    }

    if (
      options.environmentId !== undefined &&
      rule.environments.length > 0 &&
      (options.environmentId === null || !rule.environments.includes(options.environmentId))
    ) {
      skipped.push({
        ruleId: rule.id,
        ruleName: rule.name,
        reason: `Rule is scoped to ${rule.environments.join(', ')} and this request is in ${options.environmentId ?? 'an unclassified environment'}.`,
      });
      continue;
    }

    if (!ruleMatchesRequest(rule, request)) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: 'Conditions did not match this request.' });
      continue;
    }

    const budget = checkApplyBudget(rule, random);
    if (!budget.eligible) {
      skipped.push({ ruleId: rule.id, ruleName: rule.name, reason: budget.reason });
      continue;
    }

    return { matched: true, rule, action: rule.action, reason: `Matched rule "${rule.name}".`, skipped };
  }

  return { matched: false, rule: null, action: null, reason: 'No rule matched this request.', skipped };
}
