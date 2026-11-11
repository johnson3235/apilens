import type { ServerControlSettings } from '../shared/settings';

/**
 * Tags the tester's own traffic with their QA session.
 *
 * On a shared dev server every tester's requests reach the same process, and
 * page loads, RSC fetches and server actions carry no header the page hooks
 * could add. A session-scoped declarativeNetRequest rule sets
 * `x-qa-session-id` on every request this tab sends to the app's own host, so
 * the server SDK files those calls under this session instead of the shared
 * "ambient" one, and the Server API view can show just this tester's calls.
 */

/** Fixed id: one tagged tab at a time, matching the one recording session. */
export const SESSION_TAG_RULE_ID = 731_701;

export interface SessionTagInput {
  settings: ServerControlSettings;
  sessionId: string | null;
  recording: boolean;
  tabId: number | null;
  startUrl: string | null;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rule to install, or null when nothing should be tagged. */
export function sessionTagRule(input: SessionTagInput): chrome.declarativeNetRequest.Rule | null {
  const { settings, sessionId, recording, tabId, startUrl } = input;
  if (!settings.enabled || settings.tagSession === false || !recording || !sessionId || tabId === null || tabId < 0 || !startUrl) return null;
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(sessionId)) return null;
  let origin: URL;
  try {
    origin = new URL(startUrl);
  } catch {
    return null;
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null;
  return {
    id: SESSION_TAG_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'x-qa-session-id', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: sessionId }],
    },
    condition: {
      tabIds: [tabId],
      // Exactly the app's own scheme and host (any port), never other sites the page talks to.
      regexFilter: `^${escapeRegex(origin.protocol)}//${escapeRegex(origin.hostname)}(:\\d+)?/`,
      resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'other'] as chrome.declarativeNetRequest.ResourceType[],
    },
  };
}

/** Installs or removes the tag rule; failures are reported, never thrown. */
export async function syncSessionTag(api: typeof chrome, input: SessionTagInput): Promise<string | null> {
  const dnr = api.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return 'declarativeNetRequest is unavailable in this browser.';
  const rule = sessionTagRule(input);
  try {
    await dnr.updateSessionRules({ removeRuleIds: [SESSION_TAG_RULE_ID], addRules: rule ? [rule] : [] });
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}
