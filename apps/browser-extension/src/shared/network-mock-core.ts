import { RuleExecutor, RuleMatcher } from '@apilens/rule-engine';
import type { CapturedRequest, Rule } from '@apilens/shared-types';

export type NetworkMockDecision =
  | { kind: 'continue'; reason: string }
  | { kind: 'fail'; rule: Rule; errorReason: string }
  | { kind: 'fulfill'; rule: Rule; statusCode: number; body: string; headers: Record<string, string>; delayMs: number };

const matcher = new RuleMatcher();
const executor = new RuleExecutor();

function needsOriginalResponse(type: string) {
  return ['missing-field', 'null-field', 'wrong-type', 'slow-response'].includes(type);
}

function cdpErrorReason(type: string, configuredReason?: string | null) {
  if (configuredReason && ['ConnectionReset', 'TimedOut', 'NameNotResolved', 'Failed'].includes(configuredReason)) {
    return configuredReason;
  }
  if (type === 'connection-reset') return 'ConnectionReset';
  if (type === 'timeout') return 'TimedOut';
  if (type === 'dns-failure') return 'NameNotResolved';
  return 'Failed';
}

/**
 * Produces only decisions the Chrome DevTools Fetch domain can faithfully
 * perform before the request reaches the server. Rules that require reading
 * the real response stay with the page engine instead of returning a corrupt
 * synthetic response.
 */
export function decideNetworkMock(rules: Rule[], request: CapturedRequest): NetworkMockDecision {
  const match = matcher.findMatchingRule(rules, request);
  if (!match.matched || !match.rule || !match.action) {
    return { kind: 'continue', reason: 'No matching network-level rule.' };
  }

  if (needsOriginalResponse(match.action.type)) {
    return { kind: 'continue', reason: 'This rule requires the original response and is handled by the page engine.' };
  }

  const mock = executor.executeAction(match.action);
  if (mock.shouldBlock) {
    return { kind: 'fail', rule: match.rule, errorReason: cdpErrorReason(match.action.type, mock.errorReason) };
  }

  const headers = { ...mock.headers };
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  headers['x-apilens-mocked'] = 'true';
  headers['x-apilens-mocked-from'] = 'ApiLens';
  headers['x-apilens-rule'] = match.rule.name;
  headers['x-apilens-transport'] = 'chromium-network';
  headers['x-apilens-original-url'] = request.url;

  return {
    kind: 'fulfill',
    rule: match.rule,
    statusCode: Math.max(200, Math.min(599, mock.statusCode)),
    body: mock.body,
    headers,
    delayMs: mock.delayMs
  };
}
