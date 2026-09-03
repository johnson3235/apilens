import type { RedactionPolicy, RedactionRule } from '@apilens/shared-types';

/**
 * Built-in redaction rules.
 *
 * These are deliberately conservative: ApiLens inspects real production-shaped
 * traffic, so anything that even looks like a credential is masked before it
 * reaches storage, the UI or an exported evidence file.
 */
export const BUILT_IN_REDACTION_RULES: RedactionRule[] = [
  {
    id: 'auth-headers',
    label: 'Authorisation and session headers',
    headers: [
      'authorization',
      'proxy-authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'api-key',
      'x-auth-token',
      'x-access-token',
      'x-refresh-token',
      'x-csrf-token',
      'x-xsrf-token',
      'x-amz-security-token',
      'x-goog-api-key',
    ],
    bodyPaths: [],
    bodyPatterns: [],
    queryParams: ['access_token', 'id_token', 'refresh_token', 'api_key', 'apikey', 'token', 'code', 'client_secret'],
    strategy: 'mask',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'credential-fields',
    label: 'Credential and token fields in payloads',
    headers: [],
    bodyPaths: [
      'password',
      'newPassword',
      'currentPassword',
      'pin',
      'secret',
      'clientSecret',
      'client_secret',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'idToken',
      'id_token',
      'apiKey',
      'api_key',
      'privateKey',
      'sessionToken',
      'authorization',
    ],
    bodyPatterns: [],
    queryParams: [],
    strategy: 'mask',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'payment-fields',
    label: 'Payment instrument data',
    headers: [],
    bodyPaths: [
      'cardNumber',
      'card_number',
      'pan',
      'cvv',
      'cvc',
      'securityCode',
      'cardSecurityCode',
      'iban',
      'accountNumber',
      'sortCode',
      'routingNumber',
    ],
    bodyPatterns: [],
    queryParams: [],
    strategy: 'preserve-shape',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'inline-secrets',
    label: 'Inline JWTs and long bearer strings',
    headers: [],
    bodyPaths: [],
    // JWT (three base64url segments) and long opaque bearer-like strings.
    bodyPatterns: [
      'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
      '(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]{20,}',
    ],
    queryParams: [],
    strategy: 'mask',
    enabled: true,
    builtIn: true,
  },
  {
    id: 'pan-pattern',
    label: 'Card-number shaped digit sequences',
    headers: [],
    bodyPaths: [],
    bodyPatterns: ['\\b(?:\\d[ -]?){13,19}\\b'],
    queryParams: [],
    strategy: 'preserve-shape',
    enabled: true,
    builtIn: true,
  },
];

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  rules: BUILT_IN_REDACTION_RULES,
  enabled: true,
  maskToken: '«redacted»',
};

export function withAdditionalHeaders(policy: RedactionPolicy, headers: string[]): RedactionPolicy {
  if (headers.length === 0) return policy;
  const extra: RedactionRule = {
    id: 'environment-headers',
    label: 'Environment-specific headers',
    headers,
    bodyPaths: [],
    bodyPatterns: [],
    queryParams: [],
    strategy: 'mask',
    enabled: true,
    builtIn: false,
  };
  return { ...policy, rules: [...policy.rules, extra] };
}
