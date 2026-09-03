import type { BodyEncoding, CapturedBody } from '@apilens/shared-types';
import { isJsonMimeType, isTextualMimeType } from './headers';

export interface BodyCaptureOptions {
  maxBytes: number;
  mimeType: string | null;
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function byteLengthOf(value: string): number {
  if (encoder) return encoder.encode(value).length;
  return Buffer.byteLength(value, 'utf8');
}

export function emptyBody(reason: string): CapturedBody {
  return { encoding: 'omitted', content: null, byteLength: 0, mimeType: null, omittedReason: reason };
}

/**
 * Normalises any captured payload into a `CapturedBody`, enforcing the size
 * budget so a single multi-megabyte response can never blow up storage or the
 * message channel.
 */
export function captureBody(raw: string | null | undefined, options: BodyCaptureOptions): CapturedBody | null {
  if (raw === null || raw === undefined) return null;

  const byteLength = byteLengthOf(raw);
  const mimeType = options.mimeType;

  if (!isTextualMimeType(mimeType)) {
    return {
      encoding: 'omitted',
      content: null,
      byteLength,
      mimeType,
      omittedReason: `Binary payload (${mimeType ?? 'unknown type'}) is not stored.`,
    };
  }

  if (byteLength > options.maxBytes) {
    const sliced = raw.slice(0, options.maxBytes);
    return {
      encoding: 'truncated',
      content: sliced,
      byteLength,
      mimeType,
      omittedReason: `Payload truncated at ${options.maxBytes} bytes (original ${byteLength} bytes).`,
    };
  }

  return { encoding: 'utf8', content: raw, byteLength, mimeType, omittedReason: null };
}

export function bodyText(body: CapturedBody | null | undefined): string | null {
  if (!body || body.content === null) return null;
  return body.content;
}

export function isBodyComplete(body: CapturedBody | null | undefined): boolean {
  return Boolean(body && body.encoding === 'utf8');
}

export interface ParsedJsonBody {
  ok: boolean;
  value: unknown;
  error: string | null;
}

export function parseJsonBody(body: CapturedBody | null | undefined): ParsedJsonBody {
  const text = bodyText(body);
  if (text === null) return { ok: false, value: null, error: 'No body content available.' };
  if (body && body.encoding === 'truncated') {
    return { ok: false, value: null, error: 'Body was truncated and cannot be parsed reliably.' };
  }
  return safeJsonParse(text);
}

export function safeJsonParse(text: string): ParsedJsonBody {
  try {
    return { ok: true, value: JSON.parse(text) as unknown, error: null };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function bodyIsJson(body: CapturedBody | null | undefined): boolean {
  if (!body) return false;
  if (isJsonMimeType(body.mimeType)) return true;
  return body.content !== null && looksLikeJson(body.content);
}

export function makeBody(content: string, mimeType: string | null, encoding: BodyEncoding = 'utf8'): CapturedBody {
  return { encoding, content, byteLength: byteLengthOf(content), mimeType, omittedReason: null };
}
