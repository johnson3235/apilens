import type {
  EnvironmentDefinition,
  EnvironmentKind,
  EnvironmentPolicy,
  MockingDecision,
} from '@apilens/shared-types';
import { PRODUCTION_ENVIRONMENT, UNKNOWN_ENVIRONMENT } from '@apilens/shared-types';
import { matchesHostPattern } from './url';

/**
 * Hostnames that look unmistakably like production. These are used only to
 * *deny* mocking, never to allow it, so a false positive is always the safe
 * direction.
 */
const PRODUCTION_HINTS = [
  /^www\./i,
  /^api\./i,
  /^(?!.*(dev|test|qa|sit|uat|stag|preprod|sandbox|local))[a-z0-9-]+\.(com|net|org|io|co|co\.uk|ie|de|fr|es|it|nl)$/i,
];

const NON_PRODUCTION_TOKENS = /(^|[.\-_])(local|localhost|dev|development|test|testing|qa|sit|uat|stag|staging|preprod|pre-prod|sandbox|mock|internal)([.\-_]|$)/i;

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  );
}

/**
 * Resolves the environment a hostname belongs to.
 *
 * Resolution order:
 *  1. Explicit user-configured host patterns (authoritative).
 *  2. Loopback detection.
 *  3. Non-production naming tokens → `unknown` but *not* production.
 *  4. Production-looking hostnames → production (mocking blocked).
 *  5. Otherwise `unknown` (mocking blocked until the user classifies it).
 */
export function resolveEnvironment(hostname: string, policy: EnvironmentPolicy): EnvironmentDefinition {
  const host = hostname.trim().toLowerCase();
  if (!host) return UNKNOWN_ENVIRONMENT;

  for (const environment of policy.environments) {
    if (environment.hostPatterns.some((pattern) => matchesHostPattern(host, pattern))) {
      return environment;
    }
  }

  if (isLoopback(host)) {
    return policy.environments.find((environment) => environment.kind === 'local') ?? UNKNOWN_ENVIRONMENT;
  }

  if (NON_PRODUCTION_TOKENS.test(host)) {
    return UNKNOWN_ENVIRONMENT;
  }

  if (PRODUCTION_HINTS.some((pattern) => pattern.test(host))) {
    return PRODUCTION_ENVIRONMENT;
  }

  return UNKNOWN_ENVIRONMENT;
}

export function findActiveOverride(policy: EnvironmentPolicy, environmentId: string, now = Date.now()) {
  return policy.overrides.find(
    (override) => override.environmentId === environmentId && override.expiresAt > now,
  );
}

/**
 * The single gate every mocking action must pass through.
 *
 * Production and unclassified hosts are denied unless the user granted an
 * explicit, time-boxed override for that exact environment.
 */
export function canMock(hostname: string, policy: EnvironmentPolicy, now = Date.now()): MockingDecision {
  const environment = resolveEnvironment(hostname, policy);
  const override = findActiveOverride(policy, environment.id, now);

  if (override) {
    return { allowed: true, environment, viaOverride: true };
  }

  if (!environment.mockingAllowed) {
    return {
      allowed: false,
      environment,
      reason:
        environment.kind === 'prod'
          ? `Mocking is blocked on ${hostname} because it resolves to the Production environment. Grant a time-boxed override in Settings if this is genuinely a test system.`
          : `Mocking is blocked on ${hostname} because it is not classified. Add it to an environment in Settings to enable mocking.`,
    };
  }

  if (!policy.allowedKinds.includes(environment.kind)) {
    return {
      allowed: false,
      environment,
      reason: `Mocking is disabled for ${environment.name} environments by the current policy.`,
    };
  }

  return { allowed: true, environment, viaOverride: false };
}

export function isProductionKind(kind: EnvironmentKind): boolean {
  return kind === 'prod';
}

/** Removes lapsed overrides so a stale grant can never silently persist. */
export function pruneOverrides(policy: EnvironmentPolicy, now = Date.now()): EnvironmentPolicy {
  const overrides = policy.overrides.filter((override) => override.expiresAt > now);
  if (overrides.length === policy.overrides.length) return policy;
  return { ...policy, overrides };
}
