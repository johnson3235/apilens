import type { RequestMethod } from './request';

export type MatchOperator =
  | 'equals'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'glob'
  | 'exists'
  | 'notExists'
  | 'gt'
  | 'lt';

export type MatchField =
  | 'url'
  | 'path'
  | 'method'
  | 'hostname'
  | 'port'
  | 'query'
  | 'header'
  | 'body'
  | 'bodyJsonPath'
  | 'graphqlOperation'
  | 'serviceName'
  | 'statusCode'
  | 'environment';

export interface MatchCondition {
  field: MatchField;
  operator: MatchOperator;
  value: string;
  /** Header name, query parameter name, or JSONPath expression. */
  key?: string;
  caseSensitive?: boolean;
  /** Inverts the result of this single condition. */
  negate?: boolean;
}

export type FailureType =
  | 'status-code'
  | 'custom-body'
  | 'connection-reset'
  | 'timeout'
  | 'dns-failure'
  | 'offline'
  | 'empty-response'
  | 'invalid-json'
  | 'truncated-json'
  | 'slow-response'
  | 'missing-field'
  | 'null-field'
  | 'wrong-type'
  | 'add-field'
  | 'malformed-headers'
  | 'websocket-disconnect'
  | 'sse-interrupt'
  | 'rate-limit'
  | 'auth-expired'
  | 'forbidden'
  | 'service-unavailable'
  | 'passthrough';

export type FieldOperation = 'set' | 'delete' | 'nullify' | 'changeType' | 'add';

export interface FieldMutation {
  /** Dotted / bracket JSONPath, e.g. `data.items[0].amountDue`. */
  path: string;
  operation: FieldOperation;
  value?: unknown;
  /** Target type for `changeType`; inferred when omitted. */
  targetType?: 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';
}

export interface RuleAction {
  type: FailureType;
  statusCode?: number;
  statusText?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  /** Headers to strip from the response before it reaches the caller. */
  removeResponseHeaders?: string[];
  delayMs?: number;
  fieldMutations?: FieldMutation[];
  /** Network-level failure reason understood by CDP `Fetch.failRequest`. */
  errorReason?: string;
  /** Simulated network profile applied on top of the response. */
  networkProfile?: NetworkProfileId;
}

export type NetworkProfileId = 'none' | 'slow-3g' | 'fast-3g' | 'high-latency' | 'offline';

export interface NetworkProfile {
  id: NetworkProfileId;
  label: string;
  /** Additional latency applied to every matched request. */
  latencyMs: number;
  /** Download throughput in bytes/second; `0` means unthrottled. */
  downloadBytesPerSecond: number;
  offline: boolean;
}

export type ApplyMode = 'always' | 'once' | 'n-times' | 'probability' | 'after-n';

export interface Rule {
  id: string;
  scenarioId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  /** Lower number wins. */
  priority: number;
  conditions: MatchCondition[];
  conditionLogic: 'and' | 'or';
  action: RuleAction;
  applyMode: ApplyMode;
  /** Used by `n-times` and `after-n`. */
  applyLimit?: number;
  /** 0-100, used by `probability`. */
  applyProbability?: number;
  appliedCount: number;
  /** Environments this rule is allowed to run in. Empty means "inherit policy". */
  environments: string[];
  createdAt: number;
  updatedAt: number;
}

export interface RuleEvaluationResult {
  matched: boolean;
  rule: Rule | null;
  action: RuleAction | null;
  reason: string;
  /** Rules that were skipped, with the reason, to make debugging possible. */
  skipped: Array<{ ruleId: string; ruleName: string; reason: string }>;
}

export interface MockRulePreset {
  id: string;
  name: string;
  description: string;
  category: 'failure' | 'latency' | 'auth' | 'payload' | 'network';
  /** Rule template; `id`, timestamps and counters are filled in on import. */
  build(input: PresetInput): Omit<Rule, 'id' | 'createdAt' | 'updatedAt' | 'appliedCount'>;
}

export interface PresetInput {
  urlPattern: string;
  method?: RequestMethod | 'ANY';
  scenarioId?: string | null;
  environments?: string[];
}

export interface RuleBundle {
  formatVersion: 1;
  name: string;
  description: string;
  exportedAt: number;
  /** Environments the author intends this bundle to be used in. */
  environments: string[];
  rules: Rule[];
}
