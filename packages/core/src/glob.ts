/**
 * Glob matching used by URL patterns, host patterns and rule matching.
 *
 * Supports `*` (any characters except `/` unless `crossSegment`), `**` (any
 * characters including `/`) and `?` (single character). Everything else is
 * treated literally, so user-supplied patterns can never inject regex.
 */
export interface GlobOptions {
  caseSensitive?: boolean;
  /** When true a single `*` also matches `/`. Defaults to true for URLs. */
  crossSegment?: boolean;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string, options: GlobOptions = {}): RegExp {
  const crossSegment = options.crossSegment ?? true;
  let source = '';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        index += 1;
        source += '.*';
      } else {
        source += crossSegment ? '.*' : '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    source += char.replace(REGEX_SPECIALS, '\\$&');
  }

  return new RegExp(`^${source}$`, options.caseSensitive ? '' : 'i');
}

export function matchesGlob(value: string, pattern: string, options: GlobOptions = {}): boolean {
  if (!pattern) return false;
  try {
    return globToRegExp(pattern, options).test(value);
  } catch {
    return false;
  }
}

/**
 * Safe regex test. A malformed user-supplied pattern must never throw into
 * request-handling code paths.
 */
export function safeRegexTest(value: string, pattern: string, flags = ''): boolean {
  try {
    return new RegExp(pattern, flags).test(value);
  } catch {
    return false;
  }
}
