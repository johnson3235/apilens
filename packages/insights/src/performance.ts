import type { CapturedRequest, PerformanceReport, QaInsight, TraceTree } from '@apilens/shared-types';
import { DEFAULT_SLOW_REQUEST_MS } from '@apilens/shared-types';
import {
  average,
  endpointKey,
  hashString,
  isStaticAssetPath,
  percentile,
  requestLabel,
  responseBytes,
  toPathTemplate,
} from '@apilens/core';
import { flattenTree } from '@apilens/trace-engine';

export interface InsightThresholds {
  slowRequestMs: number;
  duplicateWindowMs: number;
  duplicateCountThreshold: number;
  largeResponseBytes: number;
  excessiveCallsThreshold: number;
  sequentialGapMs: number;
  downstreamShareThreshold: number;
}

export const DEFAULT_THRESHOLDS: InsightThresholds = {
  slowRequestMs: DEFAULT_SLOW_REQUEST_MS,
  duplicateWindowMs: 2_000,
  duplicateCountThreshold: 3,
  largeResponseBytes: 1024 * 1024,
  excessiveCallsThreshold: 5,
  sequentialGapMs: 50,
  downstreamShareThreshold: 0.7,
};

function apiRequests(requests: CapturedRequest[]): CapturedRequest[] {
  return requests.filter((request) => request.type !== 'static' && !isStaticAssetPath(request.path));
}

function insightId(kind: string, seed: string): string {
  return `${kind}-${hashString(seed)}`;
}

/**
 * Detects the same endpoint being called repeatedly inside a short window,
 * which almost always means a missing cache, a re-render loop or duplicated
 * data fetching.
 */
export function detectDuplicateRequests(requests: CapturedRequest[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  const grouped = new Map<string, CapturedRequest[]>();
  apiRequests(requests).forEach((request) => {
    const key = endpointKey(request.method, request.hostname, request.path);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(request);
    else grouped.set(key, [request]);
  });

  const insights: QaInsight[] = [];
  grouped.forEach((group, key) => {
    if (group.length < thresholds.duplicateCountThreshold) return;
    const ordered = [...group].sort((left, right) => left.timing.startedAt - right.timing.startedAt);

    // Find the densest window rather than the first one that crosses the
    // threshold, so the reported count reflects the real burst size.
    let windowStart = 0;
    let best: { start: number; end: number } | null = null;
    for (let index = 0; index < ordered.length; index += 1) {
      while (ordered[index]!.timing.startedAt - ordered[windowStart]!.timing.startedAt > thresholds.duplicateWindowMs) {
        windowStart += 1;
      }
      const size = index - windowStart + 1;
      if (size >= thresholds.duplicateCountThreshold && (!best || size > best.end - best.start + 1)) {
        best = { start: windowStart, end: index };
      }
    }
    if (!best) return;

    const inWindow = ordered.slice(best.start, best.end + 1);
    const spanMs = inWindow[inWindow.length - 1]!.timing.startedAt - inWindow[0]!.timing.startedAt;
    insights.push({
      id: insightId('duplicate-request', key),
      kind: 'duplicate-request',
      severity: inWindow.length >= thresholds.excessiveCallsThreshold ? 'warning' : 'info',
      title: `Duplicate request: ${key}`,
      observed: `${key} was called ${inWindow.length} times within ${Math.max(spanMs, 1)}ms.`,
      possibleCause: 'Repeated data fetching without caching or de-duplication, or a component re-render loop.',
      recommendation: 'Check whether the calls can be de-duplicated, cached, or batched into a single request.',
      requestIds: inWindow.map((request) => request.id),
      traceIds: [...new Set(inWindow.map((request) => request.traceId).filter((id): id is string => id !== null))],
      metrics: { calls: inWindow.length, windowMs: Math.max(spanMs, 1) },
    });
  });

  return insights;
}

export function detectExcessiveCalls(requests: CapturedRequest[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  const grouped = new Map<string, CapturedRequest[]>();
  apiRequests(requests).forEach((request) => {
    const key = endpointKey(request.method, request.hostname, request.path);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(request);
    else grouped.set(key, [request]);
  });

  return [...grouped.entries()]
    .filter(([, group]) => group.length > thresholds.excessiveCallsThreshold)
    .map(([key, group]) => ({
      id: insightId('excessive-calls', key),
      kind: 'excessive-calls' as const,
      severity: 'warning' as const,
      title: `High call volume: ${key}`,
      observed: `${key} accounted for ${group.length} of the ${apiRequests(requests).length} API calls in this session.`,
      possibleCause: 'Polling, an N+1 access pattern, or a retry loop.',
      recommendation: 'Confirm the call volume is intentional and consider batching or a subscription-based update.',
      requestIds: group.map((request) => request.id),
      traceIds: [...new Set(group.map((request) => request.traceId).filter((id): id is string => id !== null))],
      metrics: { calls: group.length },
    }));
}

export function detectSlowRequests(requests: CapturedRequest[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  return apiRequests(requests)
    .filter((request) => (request.timing.durationMs ?? 0) >= thresholds.slowRequestMs)
    .sort((left, right) => (right.timing.durationMs ?? 0) - (left.timing.durationMs ?? 0))
    .slice(0, 10)
    .map((request) => ({
      id: insightId('slow-request', request.id),
      kind: 'slow-request' as const,
      severity: (request.timing.durationMs ?? 0) >= thresholds.slowRequestMs * 3 ? 'critical' : 'warning',
      title: `Slow response: ${requestLabel(request)}`,
      observed: `${requestLabel(request)} took ${Math.round(request.timing.durationMs ?? 0)}ms.`,
      possibleCause: request.mock ? 'A delay was deliberately injected by an ApiLens mock rule.' : null,
      recommendation: request.mock ? null : 'Open the API Trace tab to see which downstream span consumed the time.',
      requestIds: [request.id],
      traceIds: request.traceId ? [request.traceId] : [],
      metrics: { durationMs: Math.round(request.timing.durationMs ?? 0) },
    }));
}

export function detectLargeResponses(requests: CapturedRequest[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  return requests
    .filter((request) => responseBytes(request) >= thresholds.largeResponseBytes)
    .map((request) => ({
      id: insightId('large-response', request.id),
      kind: 'large-response' as const,
      severity: 'warning' as const,
      title: `Large response: ${requestLabel(request)}`,
      observed: `${requestLabel(request)} returned ${responseBytes(request)} bytes.`,
      possibleCause: 'Missing pagination, over-fetching, or an unfiltered collection endpoint.',
      recommendation: 'Check whether the client needs the full payload or whether pagination/field selection applies.',
      requestIds: [request.id],
      traceIds: request.traceId ? [request.traceId] : [],
      metrics: { bytes: responseBytes(request) },
    }));
}

export function detectRetryLoops(requests: CapturedRequest[]): QaInsight[] {
  const chains = new Map<string, CapturedRequest[]>();
  requests
    .filter((request) => request.retryAttempt > 0)
    .forEach((request) => {
      const key = endpointKey(request.method, request.hostname, request.path);
      const bucket = chains.get(key);
      if (bucket) bucket.push(request);
      else chains.set(key, [request]);
    });

  return [...chains.entries()].map(([key, group]) => {
    const attempts = Math.max(...group.map((request) => request.retryAttempt)) + 1;
    const recovered = group.some((request) => request.statusCode !== null && request.statusCode < 400);
    return {
      id: insightId('retry-loop', key),
      kind: 'retry-loop' as const,
      severity: recovered ? 'info' : 'critical',
      title: `Retry chain: ${key}`,
      observed: `${key} was retried ${attempts - 1} time(s) and ${recovered ? 'eventually succeeded' : 'never succeeded'}.`,
      possibleCause: 'A transient downstream failure, or a client retry policy reacting to a persistent error.',
      recommendation: recovered ? null : 'Inspect the final attempt and its trace to find the persistent failure source.',
      requestIds: group.map((request) => request.id),
      traceIds: [...new Set(group.map((request) => request.traceId).filter((id): id is string => id !== null))],
      metrics: { attempts, recovered: recovered ? 'yes' : 'no' },
    };
  });
}

/**
 * Finds runs of API calls that executed back to back with negligible gaps and
 * no data dependency visible in the trace — candidates for parallelisation.
 */
export function detectSequentialWaterfalls(requests: CapturedRequest[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  const ordered = apiRequests(requests)
    .filter((request) => request.timing.completedAt !== null)
    .sort((left, right) => left.timing.startedAt - right.timing.startedAt);

  const insights: QaInsight[] = [];
  let chain: CapturedRequest[] = [];

  const flush = (): void => {
    if (chain.length < 3) {
      chain = [];
      return;
    }
    const totalMs = (chain[chain.length - 1]!.timing.completedAt ?? 0) - chain[0]!.timing.startedAt;
    const slowest = Math.max(...chain.map((request) => request.timing.durationMs ?? 0));
    insights.push({
      id: insightId('sequential-waterfall', chain.map((request) => request.id).join('|')),
      kind: 'sequential-waterfall',
      severity: 'info',
      title: `${chain.length} API calls ran sequentially`,
      observed: `${chain.length} calls executed one after another over ${Math.round(totalMs)}ms with gaps under ${thresholds.sequentialGapMs}ms.`,
      possibleCause: 'Awaiting each request in turn rather than issuing independent requests in parallel.',
      recommendation: `If these calls are independent, running them in parallel could reduce ${Math.round(totalMs)}ms to roughly ${Math.round(slowest)}ms.`,
      requestIds: chain.map((request) => request.id),
      traceIds: [...new Set(chain.map((request) => request.traceId).filter((id): id is string => id !== null))],
      metrics: { calls: chain.length, sequentialMs: Math.round(totalMs), parallelMs: Math.round(slowest) },
    });
    chain = [];
  };

  ordered.forEach((request) => {
    const previous = chain[chain.length - 1];
    if (!previous) {
      chain = [request];
      return;
    }
    const gap = request.timing.startedAt - (previous.timing.completedAt ?? previous.timing.startedAt);
    if (gap >= 0 && gap <= thresholds.sequentialGapMs) chain.push(request);
    else {
      flush();
      chain = [request];
    }
  });
  flush();

  return insights;
}

/**
 * Attributes a slow trace to the downstream span that consumed most of it.
 * Only produced when real span evidence exists.
 */
export function detectSlowDownstream(trees: TraceTree[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  return trees.flatMap((tree) => {
    if (tree.durationMs < thresholds.slowRequestMs) return [];
    const nodes = flattenTree(tree).filter((node) => node.depth > 0);
    if (nodes.length === 0) return [];

    const slowest = nodes.reduce((worst, node) => (node.span.durationMs > worst.span.durationMs ? node : worst));
    const share = slowest.span.durationMs / Math.max(tree.durationMs, 1);
    if (share < thresholds.downstreamShareThreshold) return [];

    const root = tree.roots[0];
    return [
      {
        id: insightId('slow-downstream', tree.traceId),
        kind: 'slow-downstream' as const,
        severity: 'warning' as const,
        title: `Slow downstream dependency: ${slowest.span.serviceName}`,
        observed: `${root?.span.operationName ?? 'Trace'} took ${Math.round(tree.durationMs)}ms; ${Math.round(share * 100)}% was spent in ${slowest.span.serviceName} (${Math.round(slowest.span.durationMs)}ms).`,
        possibleCause: null,
        recommendation: `Investigate ${slowest.span.serviceName}; it dominates the total time of this trace.`,
        requestIds: slowest.requestId ? [slowest.requestId] : [],
        traceIds: [tree.traceId],
        metrics: {
          traceDurationMs: Math.round(tree.durationMs),
          downstreamDurationMs: Math.round(slowest.span.durationMs),
          sharePercent: Math.round(share * 100),
          service: slowest.span.serviceName,
        },
      },
    ];
  });
}

export function detectFailedDownstream(trees: TraceTree[]): QaInsight[] {
  return trees.flatMap((tree) => {
    if (tree.errorCount === 0) return [];
    const failures = flattenTree(tree).filter((node) => node.span.status === 'error');
    const deepest = failures.reduce((worst, node) => (node.depth > worst.depth ? node : worst), failures[0]!);
    return [
      {
        id: insightId('failed-downstream', tree.traceId),
        kind: 'failed-downstream' as const,
        severity: 'critical' as const,
        title: `Failure originated in ${deepest.span.serviceName}`,
        observed: `${failures.length} span(s) in trace ${tree.traceId.slice(0, 8)} failed. The deepest failure was ${deepest.span.serviceName} (${deepest.span.statusCode ?? deepest.span.error ?? 'error'}).`,
        possibleCause: null,
        recommendation: 'Start the investigation at the deepest failing span; shallower failures are likely propagation.',
        requestIds: failures.map((node) => node.requestId).filter((id): id is string => id !== null),
        traceIds: [tree.traceId],
        metrics: { failedSpans: failures.length, deepestService: deepest.span.serviceName, depth: deepest.depth },
      },
    ];
  });
}

/**
 * Flags the same endpoint returning materially different responses within a
 * short window — a strong signal of a cache or replica consistency problem.
 */
export function detectInconsistentResponses(requests: CapturedRequest[], thresholds = DEFAULT_THRESHOLDS): QaInsight[] {
  const grouped = new Map<string, CapturedRequest[]>();
  apiRequests(requests)
    .filter((request) => request.method === 'GET' && request.responseBody?.content)
    .forEach((request) => {
      const key = `${request.hostname}${toPathTemplate(request.path)}?${JSON.stringify(request.queryParams)}`;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(request);
      else grouped.set(key, [request]);
    });

  const insights: QaInsight[] = [];
  grouped.forEach((group, key) => {
    if (group.length < 2) return;
    const ordered = [...group].sort((left, right) => left.timing.startedAt - right.timing.startedAt);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;
      const gap = current.timing.startedAt - previous.timing.startedAt;
      if (gap > thresholds.duplicateWindowMs) continue;
      if (previous.responseBody?.content === current.responseBody?.content) continue;
      insights.push({
        id: insightId('inconsistent-response', key),
        kind: 'inconsistent-response',
        severity: 'warning',
        title: `Inconsistent responses: ${current.hostname}${toPathTemplate(current.path)}`,
        observed: `The same GET returned different bodies ${Math.round(gap)}ms apart.`,
        possibleCause: 'Cache inconsistency, load-balanced replicas that are out of sync, or non-deterministic data.',
        recommendation: 'Compare the two responses in the Compare tab to see exactly which fields differ.',
        requestIds: [previous.id, current.id],
        traceIds: [previous.traceId, current.traceId].filter((id): id is string => id !== null),
        metrics: { gapMs: Math.round(gap) },
      });
      break;
    }
  });
  return insights;
}

/** Runs every deterministic detector and returns a ranked insight list. */
export function analysePerformance(
  requests: CapturedRequest[],
  trees: TraceTree[] = [],
  thresholds: InsightThresholds = DEFAULT_THRESHOLDS,
): PerformanceReport {
  const api = apiRequests(requests);
  const durations = api.map((request) => request.timing.durationMs).filter((value): value is number => value !== null);

  const byHost = new Map<string, { count: number; totalDurationMs: number }>();
  api.forEach((request) => {
    const entry = byHost.get(request.hostname) ?? { count: 0, totalDurationMs: 0 };
    entry.count += 1;
    entry.totalDurationMs += request.timing.durationMs ?? 0;
    byHost.set(request.hostname, entry);
  });

  const insights = [
    ...detectFailedDownstream(trees),
    ...detectSlowDownstream(trees, thresholds),
    ...detectRetryLoops(requests),
    ...detectDuplicateRequests(requests, thresholds),
    ...detectExcessiveCalls(requests, thresholds),
    ...detectSlowRequests(requests, thresholds),
    ...detectLargeResponses(requests, thresholds),
    ...detectInconsistentResponses(requests, thresholds),
    ...detectSequentialWaterfalls(requests, thresholds),
  ];

  const severityRank = { critical: 0, warning: 1, info: 2 };

  return {
    totalRequests: api.length,
    totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
    averageDurationMs: average(durations),
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    p99DurationMs: percentile(durations, 0.99),
    slowest: [...api]
      .sort((left, right) => (right.timing.durationMs ?? 0) - (left.timing.durationMs ?? 0))
      .slice(0, 5)
      .map((request) => ({ requestId: request.id, label: requestLabel(request), durationMs: request.timing.durationMs ?? 0 })),
    byHost: [...byHost.entries()]
      .map(([hostname, entry]) => ({
        hostname,
        count: entry.count,
        totalDurationMs: entry.totalDurationMs,
        averageDurationMs: entry.count > 0 ? entry.totalDurationMs / entry.count : 0,
      }))
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs),
    totalTransferredBytes: requests.reduce((sum, request) => sum + responseBytes(request), 0),
    insights: insights.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]),
  };
}
