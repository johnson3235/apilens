import type { CapturedRequest, SessionStats, TraceTree } from '@apilens/shared-types';
import { average, isStaticAssetPath, percentile, requestLabel } from '@apilens/core';

/** Aggregates the numbers behind the session dashboard. */
export function computeSessionStats(
  requests: CapturedRequest[],
  trees: TraceTree[],
  sessionStartedAt: number,
  sessionEndedAt: number | null,
): SessionStats {
  const api = requests.filter((request) => request.type !== 'static' && !isStaticAssetPath(request.path));
  const durations = api.map((request) => request.timing.durationMs).filter((value): value is number => value !== null);

  const statusBuckets: Record<string, number> = {};
  api.forEach((request) => {
    const key =
      request.error !== null
        ? 'error'
        : request.statusCode === null
          ? 'pending'
          : `${Math.floor(request.statusCode / 100)}xx`;
    statusBuckets[key] = (statusBuckets[key] ?? 0) + 1;
  });

  const slowest = [...api].sort((left, right) => (right.timing.durationMs ?? 0) - (left.timing.durationMs ?? 0))[0];

  return {
    requestCount: api.length,
    failedCount: api.filter((request) => request.error !== null || (request.statusCode ?? 0) >= 400).length,
    mockedCount: api.filter((request) => request.mock !== null).length,
    replayedCount: api.filter((request) => request.channel === 'replay').length,
    serverSideCount: api.filter((request) => request.channel === 'server-sdk' || request.channel === 'qa-proxy').length,
    traceCount: trees.length,
    averageDurationMs: average(durations),
    p95DurationMs: percentile(durations, 0.95),
    slowest: slowest
      ? { requestId: slowest.id, label: requestLabel(slowest), durationMs: slowest.timing.durationMs ?? 0 }
      : null,
    statusBuckets,
    pageCount: new Set(api.map((request) => request.pageUrl).filter((url): url is string => url !== null)).size,
    durationMs: Math.max(0, (sessionEndedAt ?? Date.now()) - sessionStartedAt),
  };
}
