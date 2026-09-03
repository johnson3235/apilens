export type RedactionStrategy = 'mask' | 'hash' | 'remove' | 'preserve-shape';

export interface RedactionRule {
  id: string;
  /** Human readable purpose, surfaced in the settings UI. */
  label: string;
  /** Header names (case-insensitive) to redact. */
  headers: string[];
  /** JSONPath-ish dotted paths inside request/response bodies. */
  bodyPaths: string[];
  /** Regex sources applied to raw body text as a last line of defence. */
  bodyPatterns: string[];
  /** Query parameter names to redact. */
  queryParams: string[];
  strategy: RedactionStrategy;
  enabled: boolean;
  /** Built-in rules cannot be deleted, only disabled with an explicit action. */
  builtIn: boolean;
}

export interface RedactionPolicy {
  rules: RedactionRule[];
  /**
   * Master switch. Disabling it is an explicit, logged user decision and makes
   * exported evidence carry an unmasked warning banner.
   */
  enabled: boolean;
  /** Replacement token used by the `mask` strategy. */
  maskToken: string;
}

export interface RedactionOutcome<T> {
  value: T;
  /** Dotted descriptors of everything that was redacted, e.g. `header:authorization`. */
  redactedFields: string[];
}

export type TokenLifecycleEvent =
  | 'token-issued'
  | 'token-present'
  | 'token-refreshed'
  | 'token-expired'
  | 'token-missing'
  | 'unauthorized'
  | 'forbidden'
  | 'logout';

export interface TokenObservation {
  requestId: string;
  timestamp: number;
  event: TokenLifecycleEvent;
  /** Never the token itself — only non-reversible metadata. */
  tokenFingerprint: string | null;
  issuer: string | null;
  subjectFingerprint: string | null;
  expiresAt: number | null;
  /** Seconds remaining at observation time; negative means already expired. */
  secondsToExpiry: number | null;
  scheme: string | null;
  detail: string;
}

export interface AuthFlowReport {
  observations: TokenObservation[];
  refreshCount: number;
  expiredCount: number;
  unauthorizedCount: number;
  forbiddenCount: number;
  /** Requests that retried immediately after a 401 — a healthy refresh loop. */
  refreshRetries: Array<{ unauthorizedRequestId: string; retryRequestId: string }>;
}
