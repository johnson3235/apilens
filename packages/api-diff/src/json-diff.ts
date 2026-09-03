import type { HeaderDiffEntry, JsonDiff, JsonDiffEntry, ResponseDiff } from '@apilens/shared-types';
import { flattenJson, safeJsonParse } from '@apilens/core';

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeOf(left) !== typeOf(right)) return false;
  if (typeof left === 'object' && left !== null) return JSON.stringify(left) === JSON.stringify(right);
  return false;
}

export interface JsonDiffOptions {
  /** Include unchanged leaves in the result (useful for side-by-side views). */
  includeUnchanged?: boolean;
  /** Paths to ignore, e.g. volatile ids or timestamps. */
  ignorePaths?: string[];
}

/**
 * Structural JSON diff over flattened leaf paths.
 *
 * Type changes are reported separately from value changes because
 * `amountDue: 20 → null` is a contract break, while `20 → 25` is data drift.
 */
export function diffJson(leftText: string | null, rightText: string | null, options: JsonDiffOptions = {}): JsonDiff {
  const empty: JsonDiff = {
    entries: [],
    addedCount: 0,
    removedCount: 0,
    changedCount: 0,
    typeChangedCount: 0,
    identical: false,
    parseError: null,
  };

  if (leftText === null && rightText === null) return { ...empty, identical: true };
  if (leftText === null || rightText === null) {
    return { ...empty, parseError: 'One side has no body to compare.' };
  }

  const left = safeJsonParse(leftText);
  const right = safeJsonParse(rightText);

  if (!left.ok || !right.ok) {
    return {
      ...empty,
      identical: leftText === rightText,
      parseError: !left.ok ? `Left side is not valid JSON: ${left.error}` : `Right side is not valid JSON: ${right.error}`,
    };
  }

  const leftLeaves = flattenJson(left.value);
  const rightLeaves = flattenJson(right.value);
  const ignore = new Set(options.ignorePaths ?? []);
  const paths = [...new Set([...leftLeaves.keys(), ...rightLeaves.keys()])].sort();

  const entries: JsonDiffEntry[] = [];
  paths.forEach((path) => {
    if (ignore.has(path)) return;
    const inLeft = leftLeaves.has(path);
    const inRight = rightLeaves.has(path);
    const leftValue = leftLeaves.get(path);
    const rightValue = rightLeaves.get(path);

    if (inLeft && !inRight) {
      entries.push({ path, kind: 'removed', left: leftValue, right: undefined, leftType: typeOf(leftValue), rightType: 'undefined' });
      return;
    }
    if (!inLeft && inRight) {
      entries.push({ path, kind: 'added', left: undefined, right: rightValue, leftType: 'undefined', rightType: typeOf(rightValue) });
      return;
    }
    if (equal(leftValue, rightValue)) {
      if (options.includeUnchanged) {
        entries.push({ path, kind: 'unchanged', left: leftValue, right: rightValue, leftType: typeOf(leftValue), rightType: typeOf(rightValue) });
      }
      return;
    }
    const kind = typeOf(leftValue) === typeOf(rightValue) ? 'changed' : 'type-changed';
    entries.push({ path, kind, left: leftValue, right: rightValue, leftType: typeOf(leftValue), rightType: typeOf(rightValue) });
  });

  const counted = entries.filter((entry) => entry.kind !== 'unchanged');
  return {
    entries,
    addedCount: counted.filter((entry) => entry.kind === 'added').length,
    removedCount: counted.filter((entry) => entry.kind === 'removed').length,
    changedCount: counted.filter((entry) => entry.kind === 'changed').length,
    typeChangedCount: counted.filter((entry) => entry.kind === 'type-changed').length,
    identical: counted.length === 0,
    parseError: null,
  };
}

/** Compares only the *shape* of two payloads, ignoring values. */
export function diffJsonSchemaShape(leftText: string | null, rightText: string | null): JsonDiff {
  const normalise = (text: string | null): string | null => {
    if (text === null) return null;
    const parsed = safeJsonParse(text);
    if (!parsed.ok) return text;
    const shape = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.length > 0 ? [shape(value[0])] : [];
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, shape(item)]));
      }
      return typeOf(value);
    };
    return JSON.stringify(shape(parsed.value));
  };
  return diffJson(normalise(leftText), normalise(rightText));
}

export function diffHeaders(
  left: Record<string, string>,
  right: Record<string, string>,
  ignore: string[] = ['date', 'content-length', 'x-request-id', 'x-correlation-id', 'traceparent', 'etag', 'age', 'set-cookie'],
): HeaderDiffEntry[] {
  const skip = new Set(ignore.map((name) => name.toLowerCase()));
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)].map((name) => name.toLowerCase()))]
    .filter((name) => !skip.has(name))
    .sort();

  return names
    .map((name): HeaderDiffEntry => {
      const leftValue = left[name] ?? null;
      const rightValue = right[name] ?? null;
      if (leftValue !== null && rightValue === null) return { name, kind: 'removed', left: leftValue, right: null };
      if (leftValue === null && rightValue !== null) return { name, kind: 'added', left: null, right: rightValue };
      if (leftValue !== rightValue) return { name, kind: 'changed', left: leftValue, right: rightValue };
      return { name, kind: 'unchanged', left: leftValue, right: rightValue };
    })
    .filter((entry) => entry.kind !== 'unchanged');
}

export interface DiffSide {
  statusCode: number | null;
  durationMs: number | null;
  headers: Record<string, string>;
  body: string | null;
}

/** Full original-versus-replay comparison used by the replay view. */
export function diffResponses(left: DiffSide, right: DiffSide, options: JsonDiffOptions = {}): ResponseDiff {
  const body = diffJson(left.body, right.body, options);
  return {
    status: { left: left.statusCode, right: right.statusCode, changed: left.statusCode !== right.statusCode },
    durationMs: {
      left: left.durationMs,
      right: right.durationMs,
      deltaMs: left.durationMs !== null && right.durationMs !== null ? right.durationMs - left.durationMs : null,
    },
    headers: diffHeaders(left.headers, right.headers),
    body,
    textChanged: body.parseError !== null ? left.body !== right.body : !body.identical,
  };
}
