export type SchemaViolationKind =
  | 'missing-property'
  | 'unexpected-property'
  | 'wrong-type'
  | 'nullable-mismatch'
  | 'enum-mismatch'
  | 'format-mismatch'
  | 'array-item-mismatch';

export interface SchemaViolation {
  kind: SchemaViolationKind;
  path: string;
  expected: string;
  actual: string;
  message: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  violations: SchemaViolation[];
  /** Set when validation could not run (no schema, unparsable body, …). */
  skippedReason: string | null;
}

/** A minimal, dependency-free subset of JSON Schema draft-07 / OpenAPI 3 schemas. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  nullable?: boolean;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
}

export interface ContractBinding {
  id: string;
  name: string;
  method: string;
  /** Path template with `{param}` placeholders, e.g. `/orders/{id}`. */
  pathTemplate: string;
  hostPattern: string;
  /** Status code the schema applies to; `null` matches every 2xx. */
  statusCode: number | null;
  schema: JsonSchema;
  enabled: boolean;
}

export interface ContractSet {
  id: string;
  name: string;
  sourceFormat: 'openapi' | 'json-schema';
  bindings: ContractBinding[];
  /** Shared component schemas referenced through `$ref`. */
  definitions: Record<string, JsonSchema>;
  importedAt: number;
}

export type AssertionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'matches'
  | 'exists'
  | 'notExists'
  | 'isNull'
  | 'notNull'
  | 'lessThan'
  | 'greaterThan'
  | 'typeIs';

export type AssertionTarget = 'status' | 'durationMs' | 'header' | 'body' | 'bodyJsonPath';

export interface ResponseAssertion {
  id: string;
  name: string;
  /** URL substring / glob that selects which responses this applies to. */
  urlPattern: string;
  method: string | 'ANY';
  target: AssertionTarget;
  /** Header name or JSONPath expression, depending on `target`. */
  key: string | null;
  operator: AssertionOperator;
  expected: string;
  enabled: boolean;
}

export interface AssertionResult {
  assertionId: string;
  assertionName: string;
  requestId: string;
  passed: boolean;
  actual: string;
  expected: string;
  message: string;
}

export interface AssertionReport {
  results: AssertionResult[];
  passedCount: number;
  failedCount: number;
}
