import type { CapturedRequest, RuleAction } from '@apilens/shared-types';

export type KeywordLogic = 'and' | 'or';

function searchableRequestText(request: CapturedRequest): string {
  return [request.method, request.url, request.path, request.hostname, request.statusCode ?? '', request.type]
    .join(' ')
    .toLowerCase();
}

/**
 * Returns the latest observation of each API, filtered by up to two keywords.
 * Empty keyword inputs are ignored, so a single keyword works in either box.
 */
export function findRequestCandidates(
  requests: CapturedRequest[],
  keywords: readonly string[],
  logic: KeywordLogic,
  limit = 40,
): CapturedRequest[] {
  const terms = keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
  const latestByApi = new Map<string, CapturedRequest>();

  requests.forEach((request) => latestByApi.set(`${request.method} ${request.url}`, request));

  return [...latestByApi.values()]
    .reverse()
    .filter((request) => {
      if (terms.length === 0) return true;
      const text = searchableRequestText(request);
      return logic === 'and' ? terms.every((term) => text.includes(term)) : terms.some((term) => text.includes(term));
    })
    .slice(0, limit);
}

export interface CustomMockInput {
  statusCode: string;
  responseBody: string;
  contentType: 'application/json' | 'text/plain';
}

export function buildCustomMockAction(input: CustomMockInput): RuleAction {
  const statusCode = Number(input.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 599) {
    throw new Error('Custom status must be a whole number from 200 to 599.');
  }

  return {
    type: 'status-code',
    statusCode,
    responseBody: input.responseBody,
    responseHeaders: { 'content-type': input.contentType },
  };
}
