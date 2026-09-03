import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT_POLICY, type EnvironmentPolicy } from '@apilens/shared-types';
import { canMock, pruneOverrides, resolveEnvironment } from '../environment';

const policy: EnvironmentPolicy = DEFAULT_ENVIRONMENT_POLICY;

describe('environment resolution', () => {
  it('classifies loopback hosts as local', () => {
    expect(resolveEnvironment('localhost', policy).kind).toBe('local');
    expect(resolveEnvironment('127.0.0.1', policy).kind).toBe('local');
  });

  it('classifies configured host patterns', () => {
    expect(resolveEnvironment('shop.qa.example.com', policy).id).toBe('qa');
    expect(resolveEnvironment('preprod.example.com', policy).id).toBe('preprod');
  });

  it('treats production-looking hosts as production', () => {
    expect(resolveEnvironment('www.example.com', policy).kind).toBe('prod');
    expect(resolveEnvironment('example.com', policy).kind).toBe('prod');
  });

  it('never classifies a non-production token as production', () => {
    expect(resolveEnvironment('my-sandbox-service.internal.io', policy).kind).not.toBe('prod');
  });
});

describe('mocking safety gate', () => {
  it('allows mocking on non-production environments', () => {
    const decision = canMock('localhost', policy);
    expect(decision.allowed).toBe(true);
  });

  it('blocks mocking on production', () => {
    const decision = canMock('www.example.com', policy);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('Production');
  });

  it('blocks mocking on unclassified hosts', () => {
    const decision = canMock('weird-host', policy);
    expect(decision.allowed).toBe(false);
  });

  it('allows production only with an unexpired explicit override', () => {
    const now = 1_000_000;
    const withOverride: EnvironmentPolicy = {
      ...policy,
      overrides: [{ environmentId: 'prod', expiresAt: now + 60_000, grantedAt: now, reason: 'incident drill' }],
    };
    const granted = canMock('www.example.com', withOverride, now);
    expect(granted.allowed).toBe(true);
    if (granted.allowed) expect(granted.viaOverride).toBe(true);

    const lapsed = canMock('www.example.com', withOverride, now + 120_000);
    expect(lapsed.allowed).toBe(false);
  });

  it('respects allowedKinds policy', () => {
    const restricted: EnvironmentPolicy = { ...policy, allowedKinds: ['local'] };
    expect(canMock('shop.qa.example.com', restricted).allowed).toBe(false);
    expect(canMock('localhost', restricted).allowed).toBe(true);
  });

  it('prunes lapsed overrides', () => {
    const now = 1_000;
    const dirty: EnvironmentPolicy = {
      ...policy,
      overrides: [
        { environmentId: 'prod', expiresAt: now - 1, grantedAt: 0, reason: 'old' },
        { environmentId: 'qa', expiresAt: now + 1_000, grantedAt: 0, reason: 'live' },
      ],
    };
    expect(pruneOverrides(dirty, now).overrides).toHaveLength(1);
  });
});
