import type { ApiCatalog, CatalogEntry, CapturedRequest, ScenarioSuggestion, ScenarioSuggestionSet } from '@apilens/shared-types';
import { average, endpointKey, hashString, isStaticAssetPath, toPathTemplate } from '@apilens/core';

/**
 * Turns observed traffic into a reusable API catalog.
 *
 * Endpoints are keyed by their path *template*, so `/orders/1` and
 * `/orders/2` become a single documented endpoint rather than noise.
 */
export function buildCatalog(requests: CapturedRequest[], existing: CatalogEntry[] = []): ApiCatalog {
  const byId = new Map(existing.map((entry) => [entry.id, { ...entry }]));

  requests
    .filter((request) => request.type !== 'static' && !isStaticAssetPath(request.path))
    .forEach((request) => {
      const template = toPathTemplate(request.path);
      const id = `api-${hashString(endpointKey(request.method, request.hostname, request.path))}`;
      const current = byId.get(id);

      if (!current) {
        byId.set(id, {
          id,
          method: request.method,
          hostname: request.hostname,
          pathTemplate: template,
          name: `${request.method} ${template}`,
          notes: '',
          tags: [],
          observedCount: 1,
          firstSeenAt: request.timing.startedAt,
          lastSeenAt: request.timing.startedAt,
          statusCodesSeen: request.statusCode !== null ? [request.statusCode] : [],
          averageDurationMs: request.timing.durationMs ?? 0,
          sampleRequestId: request.id,
        });
        return;
      }

      const total = current.averageDurationMs * current.observedCount + (request.timing.durationMs ?? 0);
      current.observedCount += 1;
      current.averageDurationMs = total / current.observedCount;
      current.firstSeenAt = Math.min(current.firstSeenAt, request.timing.startedAt);
      current.lastSeenAt = Math.max(current.lastSeenAt, request.timing.startedAt);
      if (request.statusCode !== null && !current.statusCodesSeen.includes(request.statusCode)) {
        current.statusCodesSeen = [...current.statusCodesSeen, request.statusCode].sort();
      }
      current.sampleRequestId = current.sampleRequestId ?? request.id;
    });

  return {
    entries: [...byId.values()].sort((left, right) => right.observedCount - left.observedCount),
    generatedAt: Date.now(),
  };
}

interface SuggestionTemplate {
  presetId: string;
  title: string;
  description: string;
  failureType: string;
  statusCode: number | null;
  risk: ScenarioSuggestion['risk'];
  /** Only suggested when the predicate holds for the observed traffic. */
  applies?: (requests: CapturedRequest[]) => boolean;
}

const usesAuth = (requests: CapturedRequest[]): boolean =>
  requests.some((request) => Object.keys(request.requestHeaders).some((name) => name.toLowerCase() === 'authorization'));

const isMutating = (requests: CapturedRequest[]): boolean =>
  requests.some((request) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method));

const returnsJson = (requests: CapturedRequest[]): boolean =>
  requests.some((request) => (request.responseBody?.mimeType ?? '').includes('json'));

const TEMPLATES: SuggestionTemplate[] = [
  { presetId: 'server-error-500', title: '500 Internal Server Error', description: 'Verify the UI shows a recoverable error instead of a blank screen.', failureType: 'status-code', statusCode: 500, risk: 'safe' },
  { presetId: 'bad-request-400', title: '400 Invalid payload', description: 'Verify client-side validation messaging for a rejected payload.', failureType: 'status-code', statusCode: 400, risk: 'safe', applies: isMutating },
  { presetId: 'auth-expired', title: '401 Expired authentication', description: 'Verify the token refresh path or redirect to login.', failureType: 'auth-expired', statusCode: 401, risk: 'safe', applies: usesAuth },
  { presetId: 'forbidden', title: '403 Unauthorised', description: 'Verify the permission-denied experience.', failureType: 'forbidden', statusCode: 403, risk: 'safe', applies: usesAuth },
  { presetId: 'conflict-409', title: '409 Duplicate transaction', description: 'Verify idempotency handling for a repeated submission.', failureType: 'status-code', statusCode: 409, risk: 'safe', applies: isMutating },
  { presetId: 'rate-limit', title: '429 Rate limited', description: 'Verify back-off behaviour and the user-facing message.', failureType: 'rate-limit', statusCode: 429, risk: 'safe' },
  { presetId: 'service-unavailable', title: '503 Dependency unavailable', description: 'Verify the degraded-service experience and retry guidance.', failureType: 'service-unavailable', statusCode: 503, risk: 'safe' },
  { presetId: 'timeout', title: 'Request timeout', description: 'Verify the loading state resolves and the user is not stuck.', failureType: 'timeout', statusCode: null, risk: 'requires-care' },
  { presetId: 'connection-reset', title: 'Connection reset', description: 'Verify recovery from an abrupt transport failure.', failureType: 'connection-reset', statusCode: null, risk: 'requires-care' },
  { presetId: 'empty-response', title: 'Empty response body', description: 'Verify the UI handles a 200 with no payload.', failureType: 'empty-response', statusCode: 200, risk: 'safe' },
  { presetId: 'invalid-json', title: 'Malformed JSON', description: 'Verify parse failures are handled without crashing the page.', failureType: 'invalid-json', statusCode: 200, risk: 'safe', applies: returnsJson },
  { presetId: 'slow-response', title: 'Slow response (5s)', description: 'Verify skeletons, spinners and timeout thresholds.', failureType: 'slow-response', statusCode: null, risk: 'safe' },
];

/**
 * Suggests negative-path scenarios for an endpoint, based on how it actually
 * behaves. Suggestions are proposals only — nothing is executed automatically,
 * and destructive ideas are flagged.
 */
export function suggestScenarios(endpointRequests: CapturedRequest[]): ScenarioSuggestionSet | null {
  const sample = endpointRequests[0];
  if (!sample) return null;

  const template = toPathTemplate(sample.path);
  const urlPattern = `*${template.replace(/\{[^}]+\}/g, '*')}*`;

  const suggestions: ScenarioSuggestion[] = TEMPLATES.filter(
    (candidate) => !candidate.applies || candidate.applies(endpointRequests),
  ).map((candidate) => ({
    id: `sug-${hashString(`${sample.method}|${template}|${candidate.presetId}`)}`,
    title: candidate.title,
    description: candidate.description,
    failureType: candidate.failureType,
    statusCode: candidate.statusCode,
    risk: candidate.risk,
    presetId: candidate.presetId,
    urlPattern,
    method: sample.method,
  }));

  const missingFieldSuggestion = buildMissingFieldSuggestion(endpointRequests, urlPattern);
  if (missingFieldSuggestion) suggestions.push(missingFieldSuggestion);

  return { endpoint: `${sample.hostname}${template}`, method: sample.method, suggestions };
}

function buildMissingFieldSuggestion(requests: CapturedRequest[], urlPattern: string): ScenarioSuggestion | null {
  const sample = requests.find((request) => request.responseBody?.content && (request.responseBody.mimeType ?? '').includes('json'));
  if (!sample) return null;
  return {
    id: `sug-${hashString(`${sample.method}|${sample.path}|missing-field`)}`,
    title: 'Missing required field',
    description: 'Remove a field from the real response to verify defensive rendering.',
    failureType: 'missing-field',
    statusCode: 200,
    risk: 'safe',
    presetId: 'field-mutation',
    urlPattern,
    method: sample.method,
  };
}

/** Groups traffic by endpoint and produces a suggestion set for each. */
export function suggestScenariosForSession(requests: CapturedRequest[]): ScenarioSuggestionSet[] {
  const grouped = new Map<string, CapturedRequest[]>();
  requests
    .filter((request) => request.type !== 'static' && !isStaticAssetPath(request.path))
    .forEach((request) => {
      const key = endpointKey(request.method, request.hostname, request.path);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(request);
      else grouped.set(key, [request]);
    });

  return [...grouped.values()]
    .map((group) => suggestScenarios(group))
    .filter((set): set is ScenarioSuggestionSet => set !== null);
}

export function catalogAverageDuration(entries: CatalogEntry[]): number {
  return average(entries.map((entry) => entry.averageDurationMs));
}
