export type MatchOperator = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'regex' | 'exists' | 'notExists';

export interface MatchCondition {
  field: 'url' | 'path' | 'method' | 'hostname' | 'query' | 'header' | 'body' | 'graphqlOperation' | 'serviceName' | 'statusCode';
  operator: MatchOperator;
  value: string;
  key?: string; // for header/query matches, the specific header/param name
  caseSensitive?: boolean;
}

export type FailureType =
  | 'status-code'
  | 'connection-reset'
  | 'timeout'
  | 'dns-failure'
  | 'empty-response'
  | 'invalid-json'
  | 'truncated-json'
  | 'slow-response'
  | 'missing-field'
  | 'null-field'
  | 'wrong-type'
  | 'malformed-headers'
  | 'websocket-disconnect'
  | 'sse-interrupt'
  | 'rate-limit'
  | 'custom-body';

export interface RuleAction {
  type: FailureType;
  statusCode?: number;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  delayMs?: number;
  modifyField?: { path: string; value: unknown; operation: 'set' | 'delete' | 'nullify' | 'changeType' };
  errorReason?: string; // for CDP Fetch.failRequest error reasons
}

export type ApplyMode = 'always' | 'once' | 'n-times' | 'probability';

export interface Rule {
  id: string;
  scenarioId: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  conditions: MatchCondition[];
  conditionLogic: 'and' | 'or';
  action: RuleAction;
  applyMode: ApplyMode;
  applyLimit?: number; // for n-times
  applyProbability?: number; // 0-100 for probability
  appliedCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuleEvaluationResult {
  matched: boolean;
  rule: Rule | null;
  action: RuleAction | null;
  reason: string;
}
