/**
 * Redaction applied before anything leaves the application process.
 *
 * The server SDK sees real customer traffic, so redaction runs on the write
 * path — not in the UI. A value that was never buffered cannot leak through an
 * evidence export, a screenshot or a shared HAR file.
 */

const SENSITIVE_HEADER =
  /authorization|cookie|token|secret|password|api[-_]?key|session|apilens|x-csrf|x-xsrf|proxy-authenticate|proxy-authorization|set-cookie/i;

/** Keys whose values are replaced wholesale, regardless of their shape. */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|token|credential|authorization|api[-_]?key|client[-_]?secret|private[-_]?key|cvv|cvc|card[-_]?number|pan\b|iban|sort[-_]?code|account[-_]?number|ssn|national[-_]?id|otp|pin\b|signature|refresh|bearer/i;

/** Value shapes that are sensitive wherever they appear. */
const SENSITIVE_VALUE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, label: '[REDACTED_JWT]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, label: '[REDACTED_BEARER]' },
  { pattern: /\b(?:\d[ -]?){13,19}\b/g, label: '[REDACTED_PAN]' },
];

export const REDACTED = '[REDACTED]';
const MAX_HEADER_VALUE = 2048;
/** Bodies deeper than this are summarised rather than walked indefinitely. */
const MAX_DEPTH = 12;

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER.test(name);
}

export function redactHeaders(headers: Headers | Record<string, string> | null): Record<string, string> {
  if (!headers) return {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([name, value]) => [name, isSensitiveHeader(name) ? REDACTED : String(value).slice(0, MAX_HEADER_VALUE)]),
  );
}

export function redactQuery(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    result[key] = SENSITIVE_KEY.test(key) || isSensitiveHeader(key) ? REDACTED : redactText(value).text;
  });
  return result;
}

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
}

function redactText(input: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = input;
  for (const { pattern, label } of SENSITIVE_VALUE) {
    text = text.replace(pattern, (match) => {
      // Skip short digit runs that only look like a card because of spacing.
      if (label === '[REDACTED_PAN]' && match.replace(/\D/g, '').length < 13) return match;
      redacted = true;
      return label;
    });
  }
  return { text, redacted };
}

function redactValue(value: unknown, extraKeys: RegExp | null, depth: number, state: { redacted: boolean }): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    const { text, redacted } = redactText(value);
    if (redacted) state.redacted = true;
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, extraKeys, depth + 1, state));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key) || (extraKeys && extraKeys.test(key))) {
        result[key] = REDACTED;
        state.redacted = true;
        continue;
      }
      result[key] = redactValue(item, extraKeys, depth + 1, state);
    }
    return result;
  }
  return value;
}

function buildExtraKeyPattern(keys: string[] | undefined): RegExp | null {
  if (!keys || keys.length === 0) return null;
  const escaped = keys
    .filter((key) => typeof key === 'string' && key.length > 0)
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return escaped.length ? new RegExp(escaped.join('|'), 'i') : null;
}

/**
 * Redacts a textual payload.
 *
 * JSON is walked structurally so a sensitive key is removed even when its
 * value would not match a pattern. Anything else falls back to value-shape
 * redaction, which still catches tokens embedded in form posts and XML.
 */
export function redactBody(
  text: string,
  contentType: string | null,
  extraRedactKeys?: string[],
): { text: string; redacted: boolean } {
  const extraKeys = buildExtraKeyPattern(extraRedactKeys);
  const looksJson = /json/i.test(contentType ?? '') || /^\s*[[{]/.test(text);

  if (looksJson) {
    try {
      const parsed: unknown = JSON.parse(text);
      const state = { redacted: false };
      const cleaned = redactValue(parsed, extraKeys, 0, state);
      return { text: JSON.stringify(cleaned, null, 2), redacted: state.redacted };
    } catch {
      // Fall through: a truncated or streaming JSON payload is still text.
    }
  }

  if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
    try {
      const params = new URLSearchParams(text);
      const redactedQuery = redactQuery(params);
      const changed = Object.values(redactedQuery).includes(REDACTED);
      return { text: new URLSearchParams(redactedQuery).toString(), redacted: changed };
    } catch {
      // Fall through to generic text redaction.
    }
  }

  const { text: cleaned, redacted } = redactText(text);
  const keyed = extraKeys
    ? cleaned.replace(
        new RegExp(`("(?:${extraKeys.source})"\\s*:\\s*)"[^"]*"`, 'gi'),
        (_match, prefix: string) => `${prefix}"${REDACTED}"`,
      )
    : cleaned;
  return { text: keyed, redacted: redacted || keyed !== cleaned };
}

/** Strips credentials and query values from a URL before it is recorded. */
export function safeUrlParts(value: string): { url: string; origin: string; path: string; query: Record<string, string> } {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { url: `[${url.protocol.replace(':', '')} URL]`, origin: '', path: '', query: {} };
    }
    return { url: `${url.origin}${url.pathname}`, origin: url.origin, path: url.pathname, query: redactQuery(url.searchParams) };
  } catch {
    return { url: '[invalid URL]', origin: '', path: '', query: {} };
  }
}
