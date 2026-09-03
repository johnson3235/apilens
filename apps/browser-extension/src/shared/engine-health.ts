import type { PageHookStatus } from './messages';
import type { Rule } from '@apilens/shared-types';
import { hashString } from '@apilens/core';

export type MockEngineKind = 'page-hook' | 'chromium-network' | 'none';

export interface MockEngineHealth {
  /** True when *some* engine is able to serve mocks for this tab. */
  ready: boolean;
  engine: MockEngineKind;
  hooksInstalled: boolean;
  rulesSynced: boolean;
  enabledRuleCount: number;
  expectedRevision: string;
  frames: Array<PageHookStatus & { frameId: number }>;
  networkMockActive: boolean;
  lastSelfTest: { ok: boolean; error?: string; testedAt: number } | null;
  error: string | null;
}

const FRAME_STATUS_TTL_MS = 45_000;

/**
 * A revision fingerprint of the enabled rule set.
 *
 * The page hooks report the revision they are running; comparing it to the
 * expected value is how we know a rule change actually reached the page rather
 * than being lost to a navigation or a torn-down content script.
 */
export function revisionForRules(rules: Rule[]): string {
  const enabled = rules
    .filter((rule) => rule.enabled)
    .map((rule) => `${rule.id}:${rule.updatedAt}:${rule.priority}:${rule.action.type}`)
    .sort()
    .join('|');
  return `${rules.filter((rule) => rule.enabled).length}-${hashString(enabled)}`;
}

export function isTopFrameSynchronized(
  topFrame: PageHookStatus | undefined,
  expectedRuleCount: number,
  expectedRevision: string,
  now = Date.now(),
): boolean {
  if (!topFrame) return false;
  if (now - topFrame.updatedAt > FRAME_STATUS_TTL_MS) return false;
  if (!topFrame.installed) return false;
  if (topFrame.ruleCount !== expectedRuleCount) return false;
  return topFrame.ruleRevision === expectedRevision;
}

export function summariseHealth(health: MockEngineHealth): string {
  if (health.ready && health.engine === 'page-hook') return 'Page hooks active';
  if (health.ready && health.engine === 'chromium-network') return 'Network interception active';
  if (health.enabledRuleCount === 0) return 'No rules enabled';
  return health.error ?? 'Mock engine not installed';
}
