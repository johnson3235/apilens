import { matchesGlob } from './glob';

export interface ParsedUrl {
  href: string;
  scheme: string;
  hostname: string;
  port: number | null;
  path: string;
  query: Record<string, string>;
  hash: string;
  valid: boolean;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_SEGMENT = /^[0-9a-f]{16,}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const MIXED_ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{12,}$/;

/** Parses a URL without ever throwing; unparsable input degrades gracefully. */
export function parseUrl(raw: string, base?: string): ParsedUrl {
  try {
    const url = new URL(raw, base);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    return {
      href: url.href,
      scheme: url.protocol.replace(/:$/, ''),
      hostname: url.hostname,
      port: url.port ? Number(url.port) : null,
      path: url.pathname,
      query,
      hash: url.hash,
      valid: true,
    };
  } catch {
    return {
      href: raw,
      scheme: '',
      hostname: '',
      port: null,
      path: raw,
      query: {},
      hash: '',
      valid: false,
    };
  }
}

/**
 * Collapses volatile path segments (ids, uuids, hashes) into `{id}` so that
 * repeated calls to the same logical endpoint group together in the catalog,
 * insights and comparison views.
 */
export function toPathTemplate(path: string): string {
  return (
    '/' +
    path
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        if (UUID_SEGMENT.test(segment)) return '{uuid}';
        if (NUMERIC_SEGMENT.test(segment)) return '{id}';
        if (HEX_SEGMENT.test(segment)) return '{hash}';
        if (MIXED_ID_SEGMENT.test(segment)) return '{id}';
        return segment;
      })
      .join('/')
  );
}

export function endpointKey(method: string, hostname: string, path: string): string {
  return `${method.toUpperCase()} ${hostname}${toPathTemplate(path)}`;
}

/**
 * Matches a URL against a user pattern. Bare substrings are treated as
 * "contains" so QA engineers can type `/payment` and get the expected result,
 * while `*` turns the pattern into a glob.
 */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes('*') || pattern.includes('?')) {
    return matchesGlob(url, pattern);
  }
  return url.toLowerCase().includes(pattern.toLowerCase());
}

export function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes('*') || pattern.includes('?')) {
    return matchesGlob(hostname, pattern, { crossSegment: true });
  }
  return hostname.toLowerCase() === pattern.toLowerCase();
}

/** True for URLs that are almost always noise in an API-focused inspector. */
export function isStaticAssetPath(path: string): boolean {
  return /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|mp4|webm|wasm)(\?|$)/i.test(
    path,
  );
}

export function buildUrl(base: string, query: Record<string, string>): string {
  const parsed = parseUrl(base);
  if (!parsed.valid) return base;
  const url = new URL(parsed.href);
  url.search = '';
  Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value));
  return url.toString();
}
