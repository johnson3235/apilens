import type { CapturedRequest, EndpointComparison, EndpointKey, SessionComparison } from '@apilens/shared-types';
import { average, bodyText, isStaticAssetPath, toPathTemplate } from '@apilens/core';
import { diffJsonSchemaShape } from './json-diff';

function keyOf(request: CapturedRequest): string {
  return `${request.method} ${request.hostname}${toPathTemplate(request.path)}`;
}

function toEndpointKey(request: CapturedRequest): EndpointKey {
  return { method: request.method, hostname: request.hostname, pathTemplate: toPathTemplate(request.path) };
}

interface EndpointBucket {
  key: EndpointKey;
  requests: CapturedRequest[];
}

function bucketise(requests: CapturedRequest[], includeStatic: boolean): Map<string, EndpointBucket> {
  const buckets = new Map<string, EndpointBucket>();
  requests.forEach((request) => {
    if (!includeStatic && (request.type === 'static' || isStaticAssetPath(request.path))) return;
    const id = keyOf(request);
    const bucket = buckets.get(id);
    if (bucket) bucket.requests.push(request);
    else buckets.set(id, { key: toEndpointKey(request), requests: [request] });
  });
  return buckets;
}

function durationsOf(requests: CapturedRequest[]): number[] {
  return requests.map((request) => request.timing.durationMs).filter((value): value is number => value !== null);
}

function representative(requests: CapturedRequest[]): CapturedRequest | undefined {
  return requests.find((request) => request.statusCode !== null && request.statusCode < 400) ?? requests[0];
}

export interface CompareOptions {
  leftLabel: string;
  rightLabel: string;
  includeStatic?: boolean;
  /** Duration increase (ms) before an endpoint is reported as slower. */
  slowerThresholdMs?: number;
}

/**
 * Compares two captured sessions endpoint by endpoint.
 *
 * This is the regression-testing workhorse: run the same journey on two
 * environments or two releases and see exactly which calls disappeared,
 * appeared, changed status, slowed down or changed response shape.
 */
export function compareSessions(
  leftRequests: CapturedRequest[],
  rightRequests: CapturedRequest[],
  options: CompareOptions,
): SessionComparison {
  const includeStatic = options.includeStatic ?? false;
  const slowerThreshold = options.slowerThresholdMs ?? 250;

  const left = bucketise(leftRequests, includeStatic);
  const right = bucketise(rightRequests, includeStatic);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();

  const endpoints: EndpointComparison[] = ids.map((id) => {
    const leftBucket = left.get(id);
    const rightBucket = right.get(id);
    const key = (leftBucket ?? rightBucket)!.key;

    const leftDurations = durationsOf(leftBucket?.requests ?? []);
    const rightDurations = durationsOf(rightBucket?.requests ?? []);
    const leftAverage = leftDurations.length > 0 ? average(leftDurations) : null;
    const rightAverage = rightDurations.length > 0 ? average(rightDurations) : null;

    const leftStatus = [...new Set((leftBucket?.requests ?? []).map((request) => request.statusCode ?? 0))].sort();
    const rightStatus = [...new Set((rightBucket?.requests ?? []).map((request) => request.statusCode ?? 0))].sort();

    const leftSample = representative(leftBucket?.requests ?? []);
    const rightSample = representative(rightBucket?.requests ?? []);

    return {
      endpoint: key,
      presence: leftBucket && rightBucket ? 'both' : leftBucket ? 'left-only' : 'right-only',
      leftCount: leftBucket?.requests.length ?? 0,
      rightCount: rightBucket?.requests.length ?? 0,
      leftAverageDurationMs: leftAverage,
      rightAverageDurationMs: rightAverage,
      durationDeltaMs: leftAverage !== null && rightAverage !== null ? rightAverage - leftAverage : null,
      leftStatusCodes: leftStatus,
      rightStatusCodes: rightStatus,
      statusChanged: JSON.stringify(leftStatus) !== JSON.stringify(rightStatus) && Boolean(leftBucket && rightBucket),
      schemaDiff:
        leftSample && rightSample
          ? diffJsonSchemaShape(bodyText(leftSample.responseBody), bodyText(rightSample.responseBody))
          : null,
    };
  });

  return {
    leftLabel: options.leftLabel,
    rightLabel: options.rightLabel,
    endpoints,
    missingInRight: endpoints.filter((item) => item.presence === 'left-only').map((item) => item.endpoint),
    extraInRight: endpoints.filter((item) => item.presence === 'right-only').map((item) => item.endpoint),
    statusRegressions: endpoints.filter(
      (item) =>
        item.statusChanged &&
        item.rightStatusCodes.some((status) => status >= 400) &&
        !item.leftStatusCodes.some((status) => status >= 400),
    ),
    slowerInRight: endpoints
      .filter((item) => item.durationDeltaMs !== null && item.durationDeltaMs >= slowerThreshold)
      .sort((a, b) => (b.durationDeltaMs ?? 0) - (a.durationDeltaMs ?? 0)),
    generatedAt: Date.now(),
  };
}

/** Endpoints whose response shape changed between the two runs. */
export function schemaRegressions(comparison: SessionComparison): EndpointComparison[] {
  return comparison.endpoints.filter(
    (item) =>
      item.presence === 'both' &&
      item.schemaDiff !== null &&
      item.schemaDiff.parseError === null &&
      !item.schemaDiff.identical,
  );
}
