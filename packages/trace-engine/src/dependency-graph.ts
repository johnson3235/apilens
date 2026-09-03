import type { ServiceDependencyGraph, TraceSpan } from '@apilens/shared-types';
import { percentile } from '@apilens/core';

/**
 * Builds a service dependency graph from real trace evidence only.
 *
 * An edge exists solely when a parent span from service A is the recorded
 * parent of a span from service B. Nothing is inferred from naming or URLs, so
 * the diagram can be trusted as documentation.
 */
export function buildDependencyGraph(spans: TraceSpan[]): ServiceDependencyGraph {
  const bySpanId = new Map<string, TraceSpan>();
  spans.forEach((span) => bySpanId.set(span.spanId, span));

  const nodeStats = new Map<string, { source: TraceSpan['source']; callCount: number; errorCount: number }>();
  const edgeStats = new Map<string, { from: string; to: string; durations: number[]; errorCount: number }>();

  spans.forEach((span) => {
    const node = nodeStats.get(span.serviceName) ?? { source: span.source, callCount: 0, errorCount: 0 };
    node.callCount += 1;
    if (span.status === 'error') node.errorCount += 1;
    nodeStats.set(span.serviceName, node);

    if (!span.parentSpanId) return;
    const parent = bySpanId.get(span.parentSpanId);
    if (!parent || parent.serviceName === span.serviceName) return;

    const key = `${parent.serviceName}→${span.serviceName}`;
    const edge = edgeStats.get(key) ?? { from: parent.serviceName, to: span.serviceName, durations: [], errorCount: 0 };
    edge.durations.push(span.durationMs);
    if (span.status === 'error') edge.errorCount += 1;
    edgeStats.set(key, edge);
  });

  return {
    nodes: [...nodeStats.entries()]
      .map(([service, stats]) => ({ service, ...stats }))
      .sort((left, right) => right.callCount - left.callCount),
    edges: [...edgeStats.values()]
      .map((edge) => {
        const total = edge.durations.reduce((sum, value) => sum + value, 0);
        return {
          from: edge.from,
          to: edge.to,
          callCount: edge.durations.length,
          errorCount: edge.errorCount,
          totalDurationMs: total,
          averageDurationMs: edge.durations.length > 0 ? total / edge.durations.length : 0,
          p95DurationMs: percentile(edge.durations, 0.95),
        };
      })
      .sort((left, right) => right.callCount - left.callCount),
  };
}

/** Renders the dependency graph as a Mermaid diagram for docs and evidence. */
export function toMermaid(graph: ServiceDependencyGraph): string {
  if (graph.nodes.length === 0) return 'graph LR\n  empty["No trace evidence captured"]';
  const safeId = (name: string): string => `s_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
  const lines = ['graph LR'];
  graph.nodes.forEach((node) => {
    const label = node.errorCount > 0 ? `${node.service}<br/>${node.errorCount} failed` : node.service;
    lines.push(`  ${safeId(node.service)}["${label}"]`);
  });
  graph.edges.forEach((edge) => {
    const label = `${edge.callCount} calls · ${Math.round(edge.averageDurationMs)}ms avg`;
    lines.push(`  ${safeId(edge.from)} -->|"${label}"| ${safeId(edge.to)}`);
  });
  return lines.join('\n');
}
