import type { CapturedRequest, ErrorCategory, ErrorGroup, ErrorReport, TraceTree } from '@apilens/shared-types';
import { bodyIsJson, endpointKey, getHeader, hashString, parseJsonBody } from '@apilens/core';
import { findDeepestFailure } from '@apilens/trace-engine';

const NETWORK_ERROR_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  { pattern: /timed?[\s_-]?out|ETIMEDOUT|TimedOut/i, category: 'timeout' },
  { pattern: /abort/i, category: 'aborted' },
  { pattern: /cors|cross-origin|Access-Control-Allow-Origin/i, category: 'cors' },
  { pattern: /ECONNRESET|ConnectionReset|connection\s*reset/i, category: 'network-error' },
  { pattern: /ENOTFOUND|NameNotResolved|dns/i, category: 'network-error' },
  { pattern: /net::ERR|failed to fetch|network\s*error|InternetDisconnected/i, category: 'network-error' },
];

/**
 * Classifies a failure into a QA-meaningful category.
 *
 * Classification is based only on observable evidence (status code, error
 * string, response payload) — never on guesswork about backend internals.
 */
export function classifyError(request: CapturedRequest): ErrorCategory | null {
  if (request.error) {
    const match = NETWORK_ERROR_PATTERNS.find((entry) => entry.pattern.test(request.error!));
    return match ? match.category : 'network-error';
  }

  const status = request.statusCode;
  if (status === null) return null;
  if (status < 400) {
    // A 2xx that claims JSON but cannot be parsed is a real defect QA must see.
    if (bodyIsJson(request.responseBody) && request.responseBody?.encoding === 'utf8') {
      const parsed = parseJsonBody(request.responseBody);
      if (!parsed.ok) return 'invalid-json';
    }
    return null;
  }

  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server-error';
  return 'client-error';
}

const CATEGORY_LABELS: Record<ErrorCategory, string> = {
  'client-error': '4xx client errors',
  'server-error': '5xx server errors',
  timeout: 'Timeouts',
  'network-error': 'Network errors',
  cors: 'CORS failures',
  authentication: 'Authentication failures (401)',
  authorization: 'Authorisation failures (403)',
  'rate-limit': 'Rate limited (429)',
  'invalid-json': 'Invalid JSON responses',
  'unexpected-response': 'Unexpected responses',
  aborted: 'Aborted requests',
};

export interface ErrorAnalysisOptions {
  trees?: TraceTree[];
}

/**
 * Groups failures by category *and* endpoint, and attributes each group to the
 * deepest failing service when trace evidence exists.
 *
 * When there is no server-side telemetry the attribution is explicitly `null`
 * rather than a guess — the UI then states that no server evidence is
 * available instead of inventing a cause.
 */
export function analyseErrors(requests: CapturedRequest[], options: ErrorAnalysisOptions = {}): ErrorReport {
  const treesById = new Map((options.trees ?? []).map((tree) => [tree.traceId, tree]));
  const grouped = new Map<string, { category: ErrorCategory; requests: CapturedRequest[] }>();

  requests.forEach((request) => {
    const category = classifyError(request);
    if (!category) return;
    const key = `${category}|${endpointKey(request.method, request.hostname, request.path)}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.requests.push(request);
    else grouped.set(key, { category, requests: [request] });
  });

  const groups: ErrorGroup[] = [...grouped.entries()].map(([key, entry]) => {
    const sample = entry.requests[0]!;
    const tree = sample.traceId ? treesById.get(sample.traceId) : undefined;
    const deepest = tree ? findDeepestFailure(tree) : null;

    return {
      id: `err-${hashString(key)}`,
      category: entry.category,
      label: `${CATEGORY_LABELS[entry.category]} · ${endpointKey(sample.method, sample.hostname, sample.path)}`,
      count: entry.requests.length,
      requestIds: entry.requests.map((request) => request.id),
      sampleRequestId: sample.id,
      statusCodes: [...new Set(entry.requests.map((request) => request.statusCode).filter((code): code is number => code !== null))].sort(),
      hostnames: [...new Set(entry.requests.map((request) => request.hostname))],
      likelyFailureSource: deepest
        ? {
            service: deepest.span.serviceName,
            spanId: deepest.span.spanId,
            confidence: 'observed',
            explanation: `Deepest failing span in the trace: ${deepest.span.serviceName} returned ${deepest.span.statusCode ?? deepest.span.error ?? 'an error'}.`,
          }
        : null,
    };
  });

  return {
    groups: groups.sort((left, right) => right.count - left.count),
    totalErrors: groups.reduce((sum, group) => sum + group.count, 0),
    generatedAt: Date.now(),
  };
}

export interface FailureContext {
  request: CapturedRequest;
  category: ErrorCategory | null;
  /** What the captured data proves. */
  observed: string[];
  /** Clearly-labelled hypotheses; never presented as fact. */
  possibleCauses: string[];
  parentRequestId: string | null;
  downstreamRequestIds: string[];
}

/** Builds the "Observed / Possible cause" panel for a single failure. */
export function explainFailure(
  request: CapturedRequest,
  allRequests: CapturedRequest[],
  trees: TraceTree[] = [],
): FailureContext {
  const category = classifyError(request);
  const observed: string[] = [];
  const possibleCauses: string[] = [];

  if (request.error) observed.push(`Transport reported: ${request.error}`);
  if (request.statusCode !== null) observed.push(`Response status ${request.statusCode}.`);
  if (request.mock) observed.push(`Response was produced by ApiLens rule "${request.mock.ruleName}" — this failure is simulated.`);
  if (request.retryAttempt > 0) observed.push(`This was retry attempt ${request.retryAttempt}.`);

  const tree = trees.find((candidate) => candidate.traceId === request.traceId);
  const deepest = tree ? findDeepestFailure(tree) : null;
  if (deepest) {
    observed.push(`Deepest failing span: ${deepest.span.serviceName} (${deepest.span.statusCode ?? deepest.span.error ?? 'error'}) at depth ${deepest.depth}.`);
  } else if (request.traceId) {
    possibleCauses.push('No server-side telemetry was received for this trace, so the failure cannot be attributed beyond the browser boundary.');
  } else {
    possibleCauses.push('This request carried no trace headers, so it cannot be linked to server-side spans.');
  }

  if (category === 'cors') {
    possibleCauses.push('The server response is missing or rejecting the required CORS headers for this origin.');
  }
  if (category === 'authentication') {
    const hasAuth = getHeader(request.requestHeaders, 'authorization') !== undefined;
    observed.push(hasAuth ? 'An Authorization header was present.' : 'No Authorization header was sent.');
    possibleCauses.push(hasAuth ? 'The credential may be expired, revoked, or issued for a different audience.' : 'The client did not attach a credential to this call.');
  }
  if (category === 'rate-limit') {
    const retryAfter = getHeader(request.responseHeaders, 'retry-after');
    if (retryAfter) observed.push(`Server asked the client to retry after ${retryAfter}.`);
  }
  if (category === 'invalid-json') {
    possibleCauses.push('The endpoint declared a JSON content type but returned a payload that does not parse.');
  }

  const sameTrace = request.traceId
    ? allRequests.filter((candidate) => candidate.traceId === request.traceId && candidate.id !== request.id)
    : [];

  return {
    request,
    category,
    observed,
    possibleCauses,
    parentRequestId: sameTrace.find((candidate) => candidate.spanId === request.parentSpanId)?.id ?? null,
    downstreamRequestIds: sameTrace.filter((candidate) => candidate.parentSpanId === request.spanId).map((candidate) => candidate.id),
  };
}
