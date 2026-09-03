import type { TraceNode, TraceSpan, TraceTree, Waterfall, WaterfallRow } from '@apilens/shared-types';

export interface TreeBuildOptions {
  /** Maps span ids back to the captured request that produced them. */
  requestIdBySpanId?: Map<string, string>;
}

function sortSpans(spans: TraceSpan[]): TraceSpan[] {
  return [...spans].sort((left, right) => left.startedAt - right.startedAt || left.spanId.localeCompare(right.spanId));
}

/**
 * Assembles spans into a parent/child tree.
 *
 * Spans whose declared parent was never received are surfaced as `orphaned`
 * roots rather than silently dropped — a missing hop is important QA evidence,
 * not something to hide.
 */
export function buildTraceTree(spans: TraceSpan[], options: TreeBuildOptions = {}): TraceTree | null {
  if (spans.length === 0) return null;

  const traceId = spans[0]!.traceId;
  const ordered = sortSpans(spans.filter((span) => span.traceId === traceId));
  if (ordered.length === 0) return null;

  const bySpanId = new Map<string, TraceSpan>();
  ordered.forEach((span) => {
    if (!bySpanId.has(span.spanId)) bySpanId.set(span.spanId, span);
  });

  const nodes = new Map<string, TraceNode>();
  ordered.forEach((span) => {
    nodes.set(span.spanId, {
      span,
      requestId: options.requestIdBySpanId?.get(span.spanId) ?? null,
      children: [],
      depth: 0,
      orphaned: span.parentSpanId !== null && !bySpanId.has(span.parentSpanId),
      subtreeDurationMs: span.durationMs,
      selfDurationMs: span.durationMs,
    });
  });

  const roots: TraceNode[] = [];
  nodes.forEach((node) => {
    const parentId = node.span.parentSpanId;
    if (parentId && nodes.has(parentId) && parentId !== node.span.spanId) {
      nodes.get(parentId)!.children.push(node);
      return;
    }
    roots.push(node);
  });

  const seen = new Set<string>();
  const assignDepth = (node: TraceNode, depth: number): void => {
    if (seen.has(node.span.spanId)) {
      // Defensive: a cyclic parent chain must never hang the UI.
      node.children = [];
      return;
    }
    seen.add(node.span.spanId);
    node.depth = depth;
    node.children.sort((left, right) => left.span.startedAt - right.span.startedAt);
    node.children.forEach((child) => assignDepth(child, depth + 1));
    const childCoverage = mergedDuration(node.children.map((child) => [child.span.startedAt, child.span.endedAt]));
    node.subtreeDurationMs = Math.max(
      node.span.durationMs,
      ...node.children.map((child) => child.span.endedAt - node.span.startedAt),
      0,
    );
    node.selfDurationMs = Math.max(0, node.span.durationMs - childCoverage);
  };

  roots.sort((left, right) => left.span.startedAt - right.span.startedAt);
  roots.forEach((root) => assignDepth(root, 0));

  const startedAt = Math.min(...ordered.map((span) => span.startedAt));
  const endedAt = Math.max(...ordered.map((span) => span.endedAt));

  return {
    traceId,
    roots,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    spanCount: ordered.length,
    errorCount: ordered.filter((span) => span.status === 'error').length,
    mockedCount: ordered.filter((span) => span.mockedBy !== null).length,
    services: [...new Set(ordered.map((span) => span.serviceName))].sort(),
    hasGaps: [...nodes.values()].some((node) => node.orphaned),
  };
}

/** Total wall-clock time covered by a set of possibly overlapping intervals. */
function mergedDuration(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let [currentStart, currentEnd] = sorted[0]!;
  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index]!;
    if (start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else {
      currentEnd = Math.max(currentEnd, end);
    }
  }
  return total + (currentEnd - currentStart);
}

export function groupSpansByTrace(spans: TraceSpan[]): Map<string, TraceSpan[]> {
  const grouped = new Map<string, TraceSpan[]>();
  spans.forEach((span) => {
    const bucket = grouped.get(span.traceId);
    if (bucket) bucket.push(span);
    else grouped.set(span.traceId, [span]);
  });
  return grouped;
}

export function buildTraceTrees(spans: TraceSpan[], options: TreeBuildOptions = {}): TraceTree[] {
  return [...groupSpansByTrace(spans).values()]
    .map((group) => buildTraceTree(group, options))
    .filter((tree): tree is TraceTree => tree !== null)
    .sort((left, right) => right.startedAt - left.startedAt);
}

export function flattenTree(tree: TraceTree): TraceNode[] {
  const output: TraceNode[] = [];
  const walk = (node: TraceNode): void => {
    output.push(node);
    node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return output;
}

/** Converts a tree into positioned rows for the waterfall timeline. */
export function buildWaterfall(tree: TraceTree): Waterfall {
  const window = Math.max(1, tree.durationMs);
  const rows: WaterfallRow[] = flattenTree(tree).map((node) => {
    const offset = Math.min(Math.max((node.span.startedAt - tree.startedAt) / window, 0), 1);
    const width = Math.min(Math.max(node.span.durationMs / window, 0.002), Math.max(1 - offset, 0.002));
    return {
      spanId: node.span.spanId,
      traceId: node.span.traceId,
      parentSpanId: node.span.parentSpanId,
      requestId: node.requestId,
      label: node.span.operationName,
      serviceName: node.span.serviceName,
      source: node.span.source,
      channel: node.span.channel,
      method: node.span.method,
      statusCode: node.span.statusCode,
      status: node.span.status,
      depth: node.depth,
      startedAt: node.span.startedAt,
      endedAt: node.span.endedAt,
      durationMs: node.span.durationMs,
      offsetRatio: offset,
      widthRatio: width,
      mockedBy: node.span.mockedBy,
      error: node.span.error,
      orphaned: node.orphaned,
    };
  });

  return { traceId: tree.traceId, startedAt: tree.startedAt, endedAt: tree.endedAt, durationMs: tree.durationMs, rows };
}

/**
 * Identifies the deepest span that failed, which is the most useful starting
 * point when diagnosing a failure that propagated up the stack.
 */
export function findDeepestFailure(tree: TraceTree): TraceNode | null {
  let deepest: TraceNode | null = null;
  flattenTree(tree).forEach((node) => {
    if (node.span.status !== 'error') return;
    if (!deepest || node.depth > deepest.depth) deepest = node;
  });
  return deepest;
}

/** Spans that ran concurrently with the given span, useful for parallelism analysis. */
export function findParallelSpans(tree: TraceTree, spanId: string): TraceNode[] {
  const all = flattenTree(tree);
  const target = all.find((node) => node.span.spanId === spanId);
  if (!target) return [];
  return all.filter(
    (node) =>
      node.span.spanId !== spanId &&
      node.span.startedAt < target.span.endedAt &&
      node.span.endedAt > target.span.startedAt,
  );
}
