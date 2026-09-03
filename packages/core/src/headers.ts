/** Case-insensitive header helpers. Header maps are stored lower-cased. */
export function normalizeHeaders(
  input: Record<string, string | string[] | number | undefined> | Headers | undefined | null,
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!input) return output;

  if (typeof (input as Headers).forEach === 'function' && typeof (input as Headers).get === 'function') {
    (input as Headers).forEach((value, key) => {
      output[key.toLowerCase()] = value;
    });
    return output;
  }

  Object.entries(input as Record<string, string | string[] | number | undefined>).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    output[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  });
  return output;
}

export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower in headers) return headers[lower];
  const found = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  return found ? headers[found] : undefined;
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

export function removeHeaders(headers: Record<string, string>, names: string[]): Record<string, string> {
  const lower = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !lower.has(key.toLowerCase())));
}

export function contentTypeOf(headers: Record<string, string>): string | null {
  const value = getHeader(headers, 'content-type');
  return value ? value.split(';')[0]!.trim().toLowerCase() : null;
}

const TEXTUAL_MIME = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|hal\+json))/;

export function isTextualMimeType(mimeType: string | null): boolean {
  if (!mimeType) return true;
  return TEXTUAL_MIME.test(mimeType) || mimeType.endsWith('+json') || mimeType.endsWith('+xml');
}

export function isJsonMimeType(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return mimeType === 'application/json' || mimeType.endsWith('+json') || mimeType === 'application/graphql-response+json';
}
