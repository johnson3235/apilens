export const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
];

export const DEFAULT_PII_PATTERNS = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b(?:\d[ -]*?){13,16}\b/g, // Credit Card
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // Phone
];

export function redactHeaders(
  headers: Record<string, string>,
  sensitiveHeaders: string[] = DEFAULT_SENSITIVE_HEADERS
): Record<string, string> {
  const redacted: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaders.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = value;
    }
  }
  
  return redacted;
}

export function redactBody(
  body: string,
  patterns: RegExp[] = DEFAULT_PII_PATTERNS
): string {
  if (!body) return body;
  
  let redactedStr = body;
  for (const pattern of patterns) {
    redactedStr = redactedStr.replace(pattern, '[REDACTED]');
  }
  
  return redactedStr;
}
