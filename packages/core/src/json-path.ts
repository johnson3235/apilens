/**
 * A tiny, dependency-free JSON path implementation.
 *
 * Supported syntax: `a.b.c`, `a[0].b`, `a.*.b`, `$.a.b`. This deliberately
 * covers the subset QA engineers actually use for field manipulation and
 * assertions, and never evaluates arbitrary expressions.
 */
export type JsonPathSegment = { kind: 'key'; value: string } | { kind: 'index'; value: number } | { kind: 'wildcard' };

export function parseJsonPath(path: string): JsonPathSegment[] {
  const segments: JsonPathSegment[] = [];
  const normalized = path.trim().replace(/^\$\.?/, '');
  if (!normalized) return segments;

  let buffer = '';
  const flushKey = () => {
    if (!buffer) return;
    segments.push(buffer === '*' ? { kind: 'wildcard' } : { kind: 'key', value: buffer });
    buffer = '';
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '.') {
      flushKey();
      continue;
    }
    if (char === '[') {
      flushKey();
      const close = normalized.indexOf(']', index);
      if (close === -1) {
        buffer += char;
        continue;
      }
      const inner = normalized.slice(index + 1, close).replace(/^['"]|['"]$/g, '');
      if (inner === '*') segments.push({ kind: 'wildcard' });
      else if (/^-?\d+$/.test(inner)) segments.push({ kind: 'index', value: Number(inner) });
      else segments.push({ kind: 'key', value: inner });
      index = close;
      continue;
    }
    buffer += char;
  }
  flushKey();
  return segments;
}

function readSegment(node: unknown, segment: JsonPathSegment): unknown[] {
  if (node === null || node === undefined) return [];
  if (segment.kind === 'wildcard') {
    if (Array.isArray(node)) return node;
    if (typeof node === 'object') return Object.values(node as Record<string, unknown>);
    return [];
  }
  if (segment.kind === 'index') {
    if (!Array.isArray(node)) return [];
    const index = segment.value < 0 ? node.length + segment.value : segment.value;
    return index in node ? [node[index]] : [];
  }
  if (Array.isArray(node)) {
    // Allow `items.0` as an alias for `items[0]`.
    if (/^\d+$/.test(segment.value)) {
      const index = Number(segment.value);
      return index in node ? [node[index]] : [];
    }
    return [];
  }
  if (typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  return segment.value in record ? [record[segment.value]] : [];
}

/** Returns every value matching the path (wildcards can yield many). */
export function queryJsonPath(root: unknown, path: string): unknown[] {
  const segments = parseJsonPath(path);
  if (segments.length === 0) return [root];
  return segments.reduce<unknown[]>(
    (nodes, segment) => nodes.flatMap((node) => readSegment(node, segment)),
    [root],
  );
}

export function getJsonPath(root: unknown, path: string): unknown {
  const matches = queryJsonPath(root, path);
  return matches.length > 0 ? matches[0] : undefined;
}

export function hasJsonPath(root: unknown, path: string): boolean {
  const segments = parseJsonPath(path);
  if (segments.length === 0) return root !== undefined;

  let nodes: unknown[] = [root];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    const next: unknown[] = [];
    for (const node of nodes) {
      if (node === null || node === undefined || typeof node !== 'object') continue;
      if (segment.kind === 'wildcard') {
        const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
        if (isLast && values.length > 0) return true;
        next.push(...values);
        continue;
      }
      if (segment.kind === 'index') {
        if (!Array.isArray(node)) continue;
        const idx = segment.value < 0 ? node.length + segment.value : segment.value;
        if (!(idx in node)) continue;
        if (isLast) return true;
        next.push(node[idx]);
        continue;
      }
      const key = segment.value;
      if (Array.isArray(node)) {
        if (!/^\d+$/.test(key)) continue;
        const idx = Number(key);
        if (!(idx in node)) continue;
        if (isLast) return true;
        next.push(node[idx]);
        continue;
      }
      const record = node as Record<string, unknown>;
      if (!(key in record)) continue;
      if (isLast) return true;
      next.push(record[key]);
    }
    nodes = next;
    if (nodes.length === 0) return false;
  }
  return false;
}

type MutationOperation =
  | { kind: 'set'; value: unknown }
  | { kind: 'delete' }
  | { kind: 'nullify' }
  | { kind: 'add'; value: unknown };

function applyToContainer(container: unknown, segment: JsonPathSegment, operation: MutationOperation): void {
  if (container === null || typeof container !== 'object') return;

  if (segment.kind === 'wildcard') {
    const keys = Array.isArray(container)
      ? container.map((_, index) => index)
      : Object.keys(container as Record<string, unknown>);
    keys.forEach((key) => applyToContainer(container, typeof key === 'number' ? { kind: 'index', value: key } : { kind: 'key', value: key }, operation));
    return;
  }

  if (Array.isArray(container)) {
    const rawIndex = segment.kind === 'index' ? segment.value : Number(segment.value);
    if (!Number.isInteger(rawIndex)) return;
    const index = rawIndex < 0 ? container.length + rawIndex : rawIndex;
    if (operation.kind === 'delete') {
      if (index >= 0 && index < container.length) container.splice(index, 1);
      return;
    }
    if (operation.kind === 'nullify') {
      if (index in container) container[index] = null;
      return;
    }
    container[index] = operation.value;
    return;
  }

  const record = container as Record<string, unknown>;
  const key = segment.kind === 'index' ? String(segment.value) : segment.value;
  if (operation.kind === 'delete') {
    delete record[key];
    return;
  }
  if (operation.kind === 'nullify') {
    if (key in record) record[key] = null;
    return;
  }
  if (operation.kind === 'add' && key in record) return;
  record[key] = operation.value;
}

function resolveParents(root: unknown, segments: JsonPathSegment[], createMissing: boolean): unknown[] {
  let nodes: unknown[] = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue;
      if (segment.kind === 'wildcard') {
        next.push(...(Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)));
        continue;
      }
      if (Array.isArray(node)) {
        const raw = segment.kind === 'index' ? segment.value : Number(segment.value);
        if (!Number.isInteger(raw)) continue;
        const index = raw < 0 ? node.length + raw : raw;
        if (!(index in node) && createMissing) node[index] = {};
        if (index in node) next.push(node[index]);
        continue;
      }
      const record = node as Record<string, unknown>;
      const key = segment.kind === 'index' ? String(segment.value) : segment.value;
      if (!(key in record) && createMissing) record[key] = {};
      if (key in record) next.push(record[key]);
    }
    nodes = next;
    if (nodes.length === 0) break;
  }
  return nodes;
}

/**
 * Applies a mutation in place and returns whether anything changed.
 * `root` must already be a mutable parsed structure.
 */
export function mutateJsonPath(root: unknown, path: string, operation: MutationOperation): boolean {
  const segments = parseJsonPath(path);
  if (segments.length === 0) return false;
  const parentSegments = segments.slice(0, -1);
  const last = segments[segments.length - 1];
  const createMissing = operation.kind === 'set' || operation.kind === 'add';
  const parents = resolveParents(root, parentSegments, createMissing);
  if (parents.length === 0) return false;
  parents.forEach((parent) => applyToContainer(parent, last, operation));
  return true;
}

export function setJsonPath(root: unknown, path: string, value: unknown): boolean {
  return mutateJsonPath(root, path, { kind: 'set', value });
}

export function deleteJsonPath(root: unknown, path: string): boolean {
  return mutateJsonPath(root, path, { kind: 'delete' });
}

export function nullifyJsonPath(root: unknown, path: string): boolean {
  return mutateJsonPath(root, path, { kind: 'nullify' });
}

export function addJsonPath(root: unknown, path: string, value: unknown): boolean {
  return mutateJsonPath(root, path, { kind: 'add', value });
}

/** Enumerates every leaf path in a JSON structure, used by the diff engine. */
export function flattenJson(value: unknown, prefix = ''): Map<string, unknown> {
  const output = new Map<string, unknown>();
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') {
      output.set(path, node);
      return;
    }
    if (Array.isArray(node)) {
      if (node.length === 0) output.set(path, []);
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 0) output.set(path, {});
    entries.forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key));
  };
  walk(value, prefix);
  return output;
}
