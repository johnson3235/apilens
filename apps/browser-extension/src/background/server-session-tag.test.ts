import { describe, expect, it, vi } from 'vitest';
import { SESSION_TAG_RULE_ID, sessionTagRule, syncSessionTag, type SessionTagInput } from './server-session-tag';

const base: SessionTagInput = {
  settings: { enabled: true, url: 'https://clear-dev.example.com', token: 'x'.repeat(32), pollIntervalMs: 2000, pollInBackground: false, tagSession: true },
  sessionId: 'session-abc', recording: true, tabId: 7, startUrl: 'https://clear-dev.example.com/myaccount',
};

describe('session tagging for a shared server', () => {
  it('sets x-qa-session-id on this tab\'s requests to the app host only', () => {
    const rule = sessionTagRule(base)!;
    expect(rule.id).toBe(SESSION_TAG_RULE_ID);
    expect(rule.action.requestHeaders).toEqual([{ header: 'x-qa-session-id', operation: 'set', value: 'session-abc' }]);
    expect(rule.condition.tabIds).toEqual([7]);
    const filter = new RegExp(rule.condition.regexFilter!);
    expect(filter.test('https://clear-dev.example.com/myaccount/billing')).toBe(true);
    expect(filter.test('https://clear-dev.example.com:8443/api/x')).toBe(true);
    expect(filter.test('https://clear-dev.example.com.evil.io/')).toBe(false);
    expect(filter.test('https://cdn.example.com/clear-dev.example.com/')).toBe(false);
    expect(rule.condition.resourceTypes).toContain('main_frame');
  });

  it('tags nothing when not recording, disabled, opted out or unsafe', () => {
    expect(sessionTagRule({ ...base, recording: false })).toBeNull();
    expect(sessionTagRule({ ...base, settings: { ...base.settings, enabled: false } })).toBeNull();
    expect(sessionTagRule({ ...base, settings: { ...base.settings, tagSession: false } })).toBeNull();
    expect(sessionTagRule({ ...base, tabId: null })).toBeNull();
    expect(sessionTagRule({ ...base, startUrl: 'chrome://extensions' })).toBeNull();
    expect(sessionTagRule({ ...base, sessionId: 'bad value\r\nx' })).toBeNull();
  });

  it('replaces the previous rule and reports errors instead of throwing', async () => {
    const updateSessionRules = vi.fn().mockResolvedValue(undefined);
    const api = { declarativeNetRequest: { updateSessionRules } } as unknown as typeof chrome;
    expect(await syncSessionTag(api, base)).toBeNull();
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [SESSION_TAG_RULE_ID], addRules: [expect.objectContaining({ id: SESSION_TAG_RULE_ID })] });
    expect(await syncSessionTag(api, { ...base, recording: false })).toBeNull();
    expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [SESSION_TAG_RULE_ID], addRules: [] });

    const failing = { declarativeNetRequest: { updateSessionRules: vi.fn().mockRejectedValue(new Error('quota')) } } as unknown as typeof chrome;
    expect(await syncSessionTag(failing, base)).toBe('quota');
  });
});
