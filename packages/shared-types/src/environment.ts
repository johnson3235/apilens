/**
 * Environment policy is the primary safety mechanism of the product.
 *
 * Mocking is a destructive capability; enabling it against production traffic
 * would be a serious incident. Every mocking decision must pass through
 * `EnvironmentPolicy`, and production requires an explicit, time-boxed
 * override that the user must actively grant.
 */
export type EnvironmentKind = 'local' | 'dev' | 'test' | 'qa' | 'sit' | 'preprod' | 'prod' | 'unknown';

export interface EnvironmentDefinition {
  id: string;
  name: string;
  kind: EnvironmentKind;
  /** Host globs, e.g. `localhost`, `*.qa.example.com`. First match wins. */
  hostPatterns: string[];
  /** Base URLs shown in the replay editor for quick environment switching. */
  baseUrls: string[];
  mockingAllowed: boolean;
  /** Reverse-proxy target used for server-side mocking in this environment. */
  proxyTarget: string | null;
  /** Extra trace headers specific to this environment. */
  traceIdHeaders: string[];
  correlationIdHeaders: string[];
  /** Extra header names to redact on top of the global policy. */
  additionalRedactedHeaders: string[];
}

export interface EnvironmentOverride {
  environmentId: string;
  /** Epoch ms after which the override lapses. Overrides are never permanent. */
  expiresAt: number;
  grantedAt: number;
  reason: string;
}

export interface EnvironmentPolicy {
  environments: EnvironmentDefinition[];
  /** Kinds where mocking is permitted without an explicit override. */
  allowedKinds: EnvironmentKind[];
  /** Active, time-boxed exceptions. */
  overrides: EnvironmentOverride[];
}

export type MockingDecision =
  | { allowed: true; environment: EnvironmentDefinition; viaOverride: boolean }
  | { allowed: false; environment: EnvironmentDefinition; reason: string };

export const BUILT_IN_ENVIRONMENTS: EnvironmentDefinition[] = [
  {
    id: 'local',
    name: 'Local',
    kind: 'local',
    hostPatterns: ['localhost', '127.0.0.1', '[::1]', '*.local', '*.localhost'],
    baseUrls: [],
    mockingAllowed: true,
    proxyTarget: null,
    traceIdHeaders: [],
    correlationIdHeaders: [],
    additionalRedactedHeaders: [],
  },
  {
    id: 'dev',
    name: 'Development',
    kind: 'dev',
    hostPatterns: ['*dev.*', '*.dev', 'dev-*'],
    baseUrls: [],
    mockingAllowed: true,
    proxyTarget: null,
    traceIdHeaders: [],
    correlationIdHeaders: [],
    additionalRedactedHeaders: [],
  },
  {
    id: 'test',
    name: 'Test',
    kind: 'test',
    hostPatterns: ['*test.*', '*.test', 'test-*'],
    baseUrls: [],
    mockingAllowed: true,
    proxyTarget: null,
    traceIdHeaders: [],
    correlationIdHeaders: [],
    additionalRedactedHeaders: [],
  },
  {
    id: 'qa',
    name: 'QA',
    kind: 'qa',
    hostPatterns: ['*qa.*', '*.qa', 'qa-*'],
    baseUrls: [],
    mockingAllowed: true,
    proxyTarget: null,
    traceIdHeaders: [],
    correlationIdHeaders: [],
    additionalRedactedHeaders: [],
  },
  {
    id: 'sit',
    name: 'SIT',
    kind: 'sit',
    hostPatterns: ['*sit.*', '*.sit', 'sit-*'],
    baseUrls: [],
    mockingAllowed: true,
    proxyTarget: null,
    traceIdHeaders: [],
    correlationIdHeaders: [],
    additionalRedactedHeaders: [],
  },
  {
    id: 'preprod',
    name: 'Pre-production',
    hostPatterns: ['*preprod.*', '*.preprod', 'preprod-*', '*staging.*', '*.staging', 'stage-*'],
    kind: 'preprod',
    baseUrls: [],
    mockingAllowed: true,
    proxyTarget: null,
    traceIdHeaders: [],
    correlationIdHeaders: [],
    additionalRedactedHeaders: [],
  },
];

export const DEFAULT_ENVIRONMENT_POLICY: EnvironmentPolicy = {
  environments: BUILT_IN_ENVIRONMENTS,
  allowedKinds: ['local', 'dev', 'test', 'qa', 'sit', 'preprod'],
  overrides: [],
};

export const UNKNOWN_ENVIRONMENT: EnvironmentDefinition = {
  id: 'unknown',
  name: 'Unclassified',
  kind: 'unknown',
  hostPatterns: [],
  baseUrls: [],
  mockingAllowed: false,
  proxyTarget: null,
  traceIdHeaders: [],
  correlationIdHeaders: [],
  additionalRedactedHeaders: [],
};

export const PRODUCTION_ENVIRONMENT: EnvironmentDefinition = {
  id: 'prod',
  name: 'Production',
  kind: 'prod',
  hostPatterns: [],
  baseUrls: [],
  mockingAllowed: false,
  proxyTarget: null,
  traceIdHeaders: [],
  correlationIdHeaders: [],
  additionalRedactedHeaders: [],
};
