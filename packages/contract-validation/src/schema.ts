import type { ContractSet, JsonSchema, SchemaValidationResult, SchemaViolation } from '@apilens/shared-types';

interface ValidationContext {
  definitions: Record<string, JsonSchema>;
  violations: SchemaViolation[];
  depth: number;
}

const MAX_DEPTH = 40;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function resolveRef(schema: JsonSchema, context: ValidationContext): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace(/^#\/(components\/schemas|definitions)\//, '');
  const resolved = context.definitions[name];
  return resolved ?? {};
}

const FORMAT_VALIDATORS: Record<string, (value: string) => boolean> = {
  'date-time': (value) => !Number.isNaN(Date.parse(value)),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  email: (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  uri: (value) => /^[a-z][a-z0-9+.-]*:/i.test(value),
};

function validateNode(value: unknown, rawSchema: JsonSchema, path: string, context: ValidationContext): void {
  if (context.depth > MAX_DEPTH) return;
  const schema = resolveRef(rawSchema, context);

  if (schema.allOf) {
    schema.allOf.forEach((sub) => validateNode(value, sub, path, { ...context, depth: context.depth + 1 }));
  }

  if (schema.oneOf || schema.anyOf) {
    const alternatives = schema.oneOf ?? schema.anyOf ?? [];
    const matched = alternatives.some((sub) => {
      const probe: ValidationContext = { definitions: context.definitions, violations: [], depth: context.depth + 1 };
      validateNode(value, sub, path, probe);
      return probe.violations.length === 0;
    });
    if (!matched) {
      context.violations.push({
        kind: 'wrong-type',
        path: path || '$',
        expected: `one of ${alternatives.length} alternative schemas`,
        actual: typeOf(value),
        message: `Value at ${path || '$'} does not satisfy any of the declared alternatives.`,
      });
    }
    return;
  }

  if (value === null) {
    const nullableByType = Array.isArray(schema.type) ? schema.type.includes('null') : schema.type === 'null';
    if (!schema.nullable && !nullableByType && schema.type !== undefined) {
      context.violations.push({
        kind: 'nullable-mismatch',
        path: path || '$',
        expected: `${Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type} (not nullable)`,
        actual: 'null',
        message: `Expected ${path || '$'} to be ${Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type} but it was null.`,
      });
    }
    return;
  }

  if (schema.type !== undefined) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((expected) => typeMatches(value, expected))) {
      context.violations.push({
        kind: 'wrong-type',
        path: path || '$',
        expected: expectedTypes.join(' | '),
        actual: typeOf(value),
        message: `Expected ${path || '$'} to be ${expectedTypes.join(' | ')} but received ${typeOf(value)}.`,
      });
      return;
    }
  }

  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    context.violations.push({
      kind: 'enum-mismatch',
      path: path || '$',
      expected: schema.enum.map((item) => JSON.stringify(item)).join(' | '),
      actual: JSON.stringify(value),
      message: `Value at ${path || '$'} is not one of the allowed values.`,
    });
  }

  if (schema.format && typeof value === 'string') {
    const validator = FORMAT_VALIDATORS[schema.format];
    if (validator && !validator(value)) {
      context.violations.push({
        kind: 'format-mismatch',
        path: path || '$',
        expected: schema.format,
        actual: value,
        message: `Value at ${path || '$'} does not match the "${schema.format}" format.`,
      });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      validateNode(item, schema.items!, `${path}[${index}]`, { ...context, depth: context.depth + 1 }),
    );
    return;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;

    (schema.required ?? []).forEach((property) => {
      if (!(property in record)) {
        context.violations.push({
          kind: 'missing-property',
          path: path ? `${path}.${property}` : property,
          expected: 'present',
          actual: 'absent',
          message: `Required property "${property}" is missing${path ? ` at ${path}` : ''}.`,
        });
      }
    });

    Object.entries(schema.properties ?? {}).forEach(([property, propertySchema]) => {
      if (!(property in record)) return;
      validateNode(record[property], propertySchema, path ? `${path}.${property}` : property, {
        ...context,
        depth: context.depth + 1,
      });
    });

    if (schema.additionalProperties === false && schema.properties) {
      Object.keys(record)
        .filter((property) => !(property in schema.properties!))
        .forEach((property) => {
          context.violations.push({
            kind: 'unexpected-property',
            path: path ? `${path}.${property}` : property,
            expected: 'not present',
            actual: typeOf(record[property]),
            message: `Unexpected property "${property}" is not declared in the schema.`,
          });
        });
    }
  }
}

/**
 * Validates a parsed payload against a JSON Schema / OpenAPI schema subset.
 *
 * Implemented in-house rather than pulled from a validator library so it runs
 * unchanged in the extension service worker, the DevTools panel and the Node
 * agent with zero dependencies and no `eval`-based code generation.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  definitions: Record<string, JsonSchema> = {},
): SchemaValidationResult {
  const context: ValidationContext = { definitions, violations: [], depth: 0 };
  validateNode(value, schema, '', context);
  return { valid: context.violations.length === 0, violations: context.violations, skippedReason: null };
}

export function skipped(reason: string): SchemaValidationResult {
  return { valid: true, violations: [], skippedReason: reason };
}

/** Finds the binding that applies to a given response, if any. */
export function findBinding(contracts: ContractSet[], method: string, hostname: string, path: string, statusCode: number | null) {
  for (const contract of contracts) {
    for (const binding of contract.bindings) {
      if (!binding.enabled) continue;
      if (binding.method.toUpperCase() !== method.toUpperCase()) continue;
      if (!hostMatches(hostname, binding.hostPattern)) continue;
      if (!pathMatchesTemplate(path, binding.pathTemplate)) continue;
      if (binding.statusCode === null) {
        if (statusCode !== null && (statusCode < 200 || statusCode >= 300)) continue;
      } else if (binding.statusCode !== statusCode) {
        continue;
      }
      return { contract, binding };
    }
  }
  return null;
}

function hostMatches(hostname: string, pattern: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
  return hostname.toLowerCase() === pattern.toLowerCase();
}

/** Matches `/orders/42` against `/orders/{id}`. */
export function pathMatchesTemplate(path: string, template: string): boolean {
  const pathSegments = path.split('/').filter(Boolean);
  const templateSegments = template.split('/').filter(Boolean);
  if (pathSegments.length !== templateSegments.length) return false;
  return templateSegments.every((segment, index) => {
    if (segment.startsWith('{') && segment.endsWith('}')) return true;
    return segment.toLowerCase() === pathSegments[index]!.toLowerCase();
  });
}
