import type { MatchCondition, MockRulePreset, PresetInput, Rule, RuleBundle } from '@apilens/shared-types';
import { createId } from '@apilens/core';

function baseConditions(input: PresetInput): MatchCondition[] {
  const conditions: MatchCondition[] = [{ field: 'url', operator: 'glob', value: input.urlPattern }];
  if (input.method && input.method !== 'ANY') {
    conditions.push({ field: 'method', operator: 'equals', value: input.method });
  }
  return conditions;
}

function preset(
  id: string,
  name: string,
  description: string,
  category: MockRulePreset['category'],
  build: (input: PresetInput, conditions: MatchCondition[]) => Pick<Rule, 'action'> & Partial<Rule>,
): MockRulePreset {
  return {
    id,
    name,
    description,
    category,
    build(input) {
      const conditions = baseConditions(input);
      const overrides = build(input, conditions);
      return {
        scenarioId: input.scenarioId ?? null,
        name,
        description,
        enabled: true,
        priority: 10,
        conditionLogic: 'and',
        conditions,
        applyMode: 'always',
        environments: input.environments ?? [],
        ...overrides,
      } as Omit<Rule, 'id' | 'createdAt' | 'updatedAt' | 'appliedCount'>;
    },
  };
}

/**
 * Ready-made failure scenarios covering the negative paths QA engineers are
 * asked to prove every release.
 */
export const RULE_PRESETS: MockRulePreset[] = [
  preset('server-error-500', 'Server error (500)', 'Returns a 500 with a structured error payload.', 'failure', () => ({
    action: { type: 'status-code', statusCode: 500 },
  })),
  preset('bad-request-400', 'Invalid payload (400)', 'Returns a 400 Bad Request.', 'failure', () => ({
    action: { type: 'status-code', statusCode: 400 },
  })),
  preset('not-found-404', 'Not found (404)', 'Returns a 404 for the matched endpoint.', 'failure', () => ({
    action: { type: 'status-code', statusCode: 404 },
  })),
  preset('conflict-409', 'Duplicate transaction (409)', 'Returns a 409 Conflict.', 'failure', () => ({
    action: { type: 'status-code', statusCode: 409 },
  })),
  preset('bad-gateway-502', 'Bad gateway (502)', 'Simulates an upstream gateway failure.', 'failure', () => ({
    action: { type: 'status-code', statusCode: 502 },
  })),
  preset('service-unavailable', 'Service unavailable (503)', 'Returns 503 with a Retry-After header.', 'failure', () => ({
    action: { type: 'service-unavailable' },
  })),
  preset('gateway-timeout-504', 'Gateway timeout (504)', 'Returns a 504 Gateway Timeout.', 'failure', () => ({
    action: { type: 'status-code', statusCode: 504 },
  })),
  preset('auth-expired', 'Authentication expired (401)', 'Returns 401 with a WWW-Authenticate challenge.', 'auth', () => ({
    action: { type: 'auth-expired' },
  })),
  preset('forbidden', 'Authorisation failure (403)', 'Returns 403 Forbidden.', 'auth', () => ({
    action: { type: 'forbidden' },
  })),
  preset('rate-limit', 'Rate limited (429)', 'Returns 429 with rate-limit headers.', 'failure', () => ({
    action: { type: 'rate-limit' },
  })),
  preset('slow-response', 'Slow response (5s)', 'Delays the real response by five seconds.', 'latency', () => ({
    action: { type: 'slow-response', delayMs: 5_000 },
  })),
  preset('timeout', 'Request timeout', 'Aborts the request as a connection timeout.', 'network', () => ({
    action: { type: 'timeout' },
  })),
  preset('connection-reset', 'Connection reset', 'Aborts the connection mid-flight.', 'network', () => ({
    action: { type: 'connection-reset' },
  })),
  preset('offline', 'Offline', 'Simulates a disconnected network for the endpoint.', 'network', () => ({
    action: { type: 'offline', networkProfile: 'offline' },
  })),
  preset('slow-3g', 'Slow 3G', 'Applies Slow 3G latency to the endpoint.', 'network', () => ({
    action: { type: 'slow-response', delayMs: 0, networkProfile: 'slow-3g' },
  })),
  preset('empty-response', 'Empty response', 'Returns 200 with a zero-length body.', 'payload', () => ({
    action: { type: 'empty-response', statusCode: 200 },
  })),
  preset('invalid-json', 'Malformed JSON', 'Returns a syntactically invalid JSON document.', 'payload', () => ({
    action: { type: 'invalid-json' },
  })),
  preset('truncated-json', 'Truncated JSON', 'Returns a JSON document cut off mid-structure.', 'payload', () => ({
    action: { type: 'truncated-json' },
  })),
];

export function findPreset(id: string): MockRulePreset | undefined {
  return RULE_PRESETS.find((item) => item.id === id);
}

/** Materialises a preset into a persistable rule. */
export function instantiatePreset(presetId: string, input: PresetInput, now = Date.now()): Rule | null {
  const found = findPreset(presetId);
  if (!found) return null;
  return { ...found.build(input), id: createId(), appliedCount: 0, createdAt: now, updatedAt: now };
}

/** Builds a rule that nullifies a JSON field in the genuine response. */
export function buildFieldMutationRule(
  input: PresetInput & { fieldPath: string; operation: 'delete' | 'nullify' | 'changeType'; ruleName?: string },
  now = Date.now(),
): Rule {
  const typeByOperation = { delete: 'missing-field', nullify: 'null-field', changeType: 'wrong-type' } as const;
  return {
    id: createId(),
    scenarioId: input.scenarioId ?? null,
    name: input.ruleName ?? `${input.operation} ${input.fieldPath}`,
    description: `Applies "${input.operation}" to ${input.fieldPath} in the real response.`,
    enabled: true,
    priority: 10,
    conditions: baseConditions(input),
    conditionLogic: 'and',
    action: {
      type: typeByOperation[input.operation],
      fieldMutations: [{ path: input.fieldPath, operation: input.operation }],
    },
    applyMode: 'always',
    environments: input.environments ?? [],
    appliedCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Serialises rules for sharing. Counters and ids are reset on import. */
export function exportRuleBundle(name: string, description: string, rules: Rule[], now = Date.now()): RuleBundle {
  return {
    formatVersion: 1,
    name,
    description,
    exportedAt: now,
    environments: [...new Set(rules.flatMap((rule) => rule.environments))],
    rules: rules.map((rule) => ({ ...rule, appliedCount: 0 })),
  };
}

export interface BundleParseResult {
  bundle: RuleBundle | null;
  error: string | null;
}

/** Parses and normalises an imported bundle; never trusts the file contents. */
export function parseRuleBundle(json: string, now = Date.now()): BundleParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { bundle: null, error: error instanceof Error ? error.message : 'Invalid JSON.' };
  }

  const raw = Array.isArray(parsed) ? { rules: parsed } : (parsed as Record<string, unknown> | null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) {
    return { bundle: null, error: 'Bundle does not contain a "rules" array.' };
  }

  const rules = (raw.rules as unknown[]).map((entry) => normaliseRule(entry, now)).filter((rule): rule is Rule => rule !== null);
  if (rules.length === 0) return { bundle: null, error: 'Bundle contained no valid rules.' };

  return {
    bundle: {
      formatVersion: 1,
      name: typeof raw.name === 'string' ? raw.name : 'Imported bundle',
      description: typeof raw.description === 'string' ? raw.description : '',
      exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : now,
      environments: Array.isArray(raw.environments) ? (raw.environments as string[]).filter((item) => typeof item === 'string') : [],
      rules,
    },
    error: null,
  };
}

function normaliseRule(entry: unknown, now: number): Rule | null {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry as Record<string, unknown>;
  const action = raw.action as Record<string, unknown> | undefined;
  if (!action || typeof action.type !== 'string') return null;

  const conditions = Array.isArray(raw.conditions)
    ? (raw.conditions as unknown[])
        .filter((condition): condition is Record<string, unknown> => Boolean(condition) && typeof condition === 'object')
        .map((condition) => ({
          field: String(condition.field ?? 'url'),
          operator: String(condition.operator ?? 'contains'),
          value: String(condition.value ?? ''),
          key: condition.key === undefined ? undefined : String(condition.key),
          caseSensitive: Boolean(condition.caseSensitive),
          negate: Boolean(condition.negate),
        })) as MatchCondition[]
    : [];

  return {
    id: typeof raw.id === 'string' ? raw.id : createId(),
    scenarioId: typeof raw.scenarioId === 'string' ? raw.scenarioId : null,
    name: typeof raw.name === 'string' ? raw.name : 'Imported rule',
    description: typeof raw.description === 'string' ? raw.description : '',
    // Imported rules always arrive disabled so nothing fires the instant a
    // colleague's bundle is opened.
    enabled: false,
    priority: typeof raw.priority === 'number' ? raw.priority : 10,
    conditions,
    conditionLogic: raw.conditionLogic === 'or' ? 'or' : 'and',
    action: action as unknown as Rule['action'],
    applyMode: (['always', 'once', 'n-times', 'probability', 'after-n'] as const).includes(raw.applyMode as never)
      ? (raw.applyMode as Rule['applyMode'])
      : 'always',
    applyLimit: typeof raw.applyLimit === 'number' ? raw.applyLimit : undefined,
    applyProbability: typeof raw.applyProbability === 'number' ? raw.applyProbability : undefined,
    appliedCount: 0,
    environments: Array.isArray(raw.environments) ? (raw.environments as string[]).filter((item) => typeof item === 'string') : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: now,
  };
}
