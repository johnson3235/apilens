import { describe, expect, it } from 'vitest';
import { canMock } from '@apilens/core';
import { DEFAULT_ENVIRONMENT_POLICY } from '@apilens/shared-types';
import type { ExtensionSettings } from '../shared/settings';
import { withTemporaryHostOverride } from './temporary-host-override';

const settings = (): ExtensionSettings => ({ environments: { ...DEFAULT_ENVIRONMENT_POLICY, environments: [...DEFAULT_ENVIRONMENT_POLICY.environments], overrides: [] } } as unknown as ExtensionSettings);

describe('temporary exact-host mock override', () => {
  it('allows only the chosen production hostname for ten minutes', () => {
    const now = 1_000_000;
    const configured = withTemporaryHostOverride(settings(), 'www.clearmobile.ie', now);
    expect(canMock('www.clearmobile.ie', configured.environments, now + 1).allowed).toBe(true);
    expect(canMock('www.example.com', configured.environments, now + 1).allowed).toBe(false);
    expect(canMock('www.clearmobile.ie', configured.environments, now + 10 * 60_000 + 1).allowed).toBe(false);
  });

  it('replaces rather than accumulates an override for the same host', () => {
    const once = withTemporaryHostOverride(settings(), 'www.clearmobile.ie', 1_000);
    const twice = withTemporaryHostOverride(once, 'WWW.CLEARMOBILE.IE', 2_000);
    expect(twice.environments.overrides.filter((item) => item.environmentId === 'temporary-www-clearmobile-ie')).toHaveLength(1);
  });
});
