import { describe, expect, it } from 'vitest';
import { isMixedBuild, isUnsupportedRecentRequest, selectActiveWebTabId } from './popup-compat';

describe('popup compatibility', () => {
  it('falls back to the last focused HTTP tab when the popup window has no web tab', () => {
    expect(selectActiveWebTabId([{ id: 1, url: 'chrome-extension://popup' }], [{ id: 7, url: 'https://www.clearmobile.ie/' }])).toBe(7);
  });

  it('detects the stale service-worker response from older builds', () => {
    expect(isUnsupportedRecentRequest({ ok: false, error: 'Unsupported request "recent:get".' })).toBe(true);
    expect(isUnsupportedRecentRequest({ ok: true })).toBe(false);
  });

  it('requires reload when popup and worker versions differ', () => {
    expect(isMixedBuild('1.1.0', '1.0.0')).toBe(true);
    expect(isMixedBuild('1.1.0', '1.1.0')).toBe(false);
  });
});
