import type {
  AssertionReport,
  AssertionResult,
  CapturedRequest,
  ContractSet,
  ResponseAssertion,
  SchemaValidationResult,
} from '@apilens/shared-types';
import { getHeader, matchesUrlPattern, parseJsonBody, queryJsonPath, safeRegexTest } from '@apilens/core';
import { findBinding, skipped, validateAgainstSchema } from './schema';

function describe(value: unknown): string {
  if (value === undefined) return '<absent>';
  if (value === null) return 'null';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function resolveActual(assertion: ResponseAssertion, request: CapturedRequest): unknown {
  switch (assertion.target) {
    case 'status':
      return request.statusCode;
    case 'durationMs':
      return request.timing.durationMs;
    case 'header':
      return assertion.key ? getHeader(request.responseHeaders, assertion.key) : undefined;
    case 'body':
      return request.responseBody?.content ?? undefined;
    case 'bodyJsonPath': {
      if (!assertion.key) return undefined;
      const parsed = parseJsonBody(request.responseBody);
      if (!parsed.ok) return undefined;
      const matches = queryJsonPath(parsed.value, assertion.key);
      return matches.length > 0 ? matches[0] : undefined;
    }
    default:
      return undefined;
  }
}

function evaluate(assertion: ResponseAssertion, actual: unknown): boolean {
  const expected = assertion.expected;

  switch (assertion.operator) {
    case 'exists':
      return actual !== undefined;
    case 'notExists':
      return actual === undefined;
    case 'isNull':
      return actual === null;
    case 'notNull':
      return actual !== null && actual !== undefined;
    case 'equals':
      return describe(actual) === expected;
    case 'notEquals':
      return describe(actual) !== expected;
    case 'contains':
      return typeof actual === 'string' ? actual.includes(expected) : describe(actual).includes(expected);
    case 'matches':
      return safeRegexTest(describe(actual), expected);
    case 'lessThan':
      return Number(actual) < Number(expected);
    case 'greaterThan':
      return Number(actual) > Number(expected);
    case 'typeIs': {
      if (actual === null) return expected === 'null';
      if (Array.isArray(actual)) return expected === 'array';
      return typeof actual === expected;
    }
    default:
      return false;
  }
}

export function assertionApplies(assertion: ResponseAssertion, request: CapturedRequest): boolean {
  if (!assertion.enabled) return false;
  if (assertion.method !== 'ANY' && assertion.method.toUpperCase() !== request.method) return false;
  return matchesUrlPattern(request.url, assertion.urlPattern);
}

/**
 * Runs lightweight QA assertions against a captured response.
 *
 * Deliberately simple and declarative so a QA engineer can add
 * `Expect $.status = ACTIVE` in seconds without writing code.
 */
export function runAssertions(assertions: ResponseAssertion[], request: CapturedRequest): AssertionResult[] {
  return assertions
    .filter((assertion) => assertionApplies(assertion, request))
    .map((assertion) => {
      const actual = resolveActual(assertion, request);
      const passed = evaluate(assertion, actual);
      return {
        assertionId: assertion.id,
        assertionName: assertion.name,
        requestId: request.id,
        passed,
        actual: describe(actual),
        expected: assertion.expected,
        message: passed
          ? `${assertion.name} passed.`
          : `${assertion.name} failed: expected ${assertion.target}${assertion.key ? ` "${assertion.key}"` : ''} ${assertion.operator} ${assertion.expected}, got ${describe(actual)}.`,
      };
    });
}

export function runAssertionsForSession(
  assertions: ResponseAssertion[],
  requests: CapturedRequest[],
): AssertionReport {
  const results = requests.flatMap((request) => runAssertions(assertions, request));
  return {
    results,
    passedCount: results.filter((result) => result.passed).length,
    failedCount: results.filter((result) => !result.passed).length,
  };
}

/** Validates a captured response against whichever contract binding applies. */
export function validateResponse(request: CapturedRequest, contracts: ContractSet[]): SchemaValidationResult {
  const match = findBinding(contracts, request.method, request.hostname, request.path, request.statusCode);
  if (!match) return skipped('No contract binding matches this endpoint.');

  const parsed = parseJsonBody(request.responseBody);
  if (!parsed.ok) return skipped(parsed.error ?? 'Response body is not parsable JSON.');

  return validateAgainstSchema(parsed.value, match.binding.schema, match.contract.definitions);
}

export function validateSession(
  requests: CapturedRequest[],
  contracts: ContractSet[],
): Array<{ requestId: string; result: SchemaValidationResult }> {
  return requests
    .map((request) => ({ requestId: request.id, result: validateResponse(request, contracts) }))
    .filter((entry) => entry.result.skippedReason === null);
}
