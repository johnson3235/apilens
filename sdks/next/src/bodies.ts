import type { BodyCaptureOptions, CapturedBody } from './types';
import { redactBody } from './redaction';

/**
 * Bounded payload capture.
 *
 * Every function here follows one rule: the application's own stream is never
 * consumed. Bodies are read from a `clone()` branch, capped, and abandoned as
 * soon as the cap is hit, so instrumenting a large download cannot turn into
 * an out-of-memory incident.
 */

export const DEFAULT_TEXT_CONTENT_TYPES = [
  'application/json',
  'application/problem+json',
  'application/ld+json',
  'application/graphql',
  'application/graphql-response+json',
  'application/x-www-form-urlencoded',
  'application/xml',
  'application/javascript',
  'text/',
  '+json',
  '+xml',
];

export interface BodyCaptureConfig {
  request: boolean;
  response: boolean;
  maxBytes: number;
  contentTypes: string[];
  redactKeys: string[];
  includeBinary: boolean;
}

const MAX_ALLOWED_BYTES = 4 * 1024 * 1024;

export function resolveBodyCapture(options: BodyCaptureOptions | undefined): BodyCaptureConfig {
  const maxBytes = Math.max(0, Math.min(options?.maxBytes ?? 128 * 1024, MAX_ALLOWED_BYTES));
  return {
    request: options?.request !== false,
    response: options?.response !== false,
    maxBytes,
    contentTypes: options?.contentTypes?.length ? options.contentTypes : DEFAULT_TEXT_CONTENT_TYPES,
    redactKeys: options?.redactKeys ?? [],
    includeBinary: options?.includeBinary === true,
  };
}

type Classification = 'text' | 'binary' | 'skip';

export function classifyContentType(contentType: string | null, config: BodyCaptureConfig): Classification {
  const value = (contentType ?? '').toLowerCase();
  if (!value) return 'text'; // Unlabelled bodies are usually JSON from internal services.
  if (config.contentTypes.some((candidate) => value.includes(candidate.toLowerCase()))) return 'text';
  return config.includeBinary ? 'binary' : 'skip';
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - size;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, Math.max(remaining, 0)));
        size += Math.max(remaining, 0);
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // Never awaited: a tee's cancel promise only settles once *both* branches
    // cancel, so awaiting it would deadlock whenever the application still
    // holds its own branch.
    void reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

function finalise(
  bytes: Uint8Array,
  truncated: boolean,
  contentType: string | null,
  classification: Classification,
  config: BodyCaptureConfig,
): CapturedBody {
  if (classification === 'binary') {
    return {
      content: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
      contentType,
      byteLength: bytes.byteLength,
      truncated,
      redacted: false,
    };
  }
  const text = Buffer.from(bytes).toString('utf8');
  const { text: cleaned, redacted } = redactBody(text, contentType, config.redactKeys);
  return {
    content: cleaned,
    encoding: 'utf8',
    contentType,
    byteLength: bytes.byteLength,
    truncated,
    redacted,
  };
}

export interface CaptureOutcome {
  body: CapturedBody | null;
  /** Human-readable explanation shown in the UI when `body` is null. */
  omitted: string | null;
}

const NOT_CAPTURED: CaptureOutcome = { body: null, omitted: null };

/**
 * Captures a `Request`/`Response` payload from a throwaway clone.
 *
 * Returns immediately with an explanation instead of throwing: a body we could
 * not read must never turn into a failed application request.
 */
export async function captureMessageBody(
  message: Request | Response,
  config: BodyCaptureConfig,
): Promise<CaptureOutcome> {
  if (config.maxBytes === 0) return { body: null, omitted: 'Body capture cap is 0 bytes' };
  if (message.bodyUsed) return { body: null, omitted: 'Body was already consumed before capture' };
  if (!message.body) return NOT_CAPTURED;

  const contentType = message.headers.get('content-type');
  const classification = classifyContentType(contentType, config);
  if (classification === 'skip') {
    return { body: null, omitted: `Not captured: ${contentType ?? 'unknown content type'} is treated as binary` };
  }

  let branch: Request | Response;
  try {
    branch = message.clone();
  } catch (error) {
    return { body: null, omitted: `Body could not be cloned (${error instanceof Error ? error.name : 'unknown'})` };
  }
  if (!branch.body) return NOT_CAPTURED;

  try {
    const { bytes, truncated } = await readCapped(branch.body, config.maxBytes);
    if (bytes.byteLength === 0 && !truncated) return NOT_CAPTURED;
    return { body: finalise(bytes, truncated, contentType, classification, config), omitted: null };
  } catch (error) {
    return { body: null, omitted: `Body read failed (${error instanceof Error ? error.name : 'unknown'})` };
  }
}

/**
 * Captures an outgoing `RequestInit.body` without constructing a `Request`.
 *
 * Constructing one would consume a stream body and force callers to supply
 * `duplex`, so each supported shape is read directly and streams are reported
 * as intentionally skipped.
 */
export async function captureInitBody(
  body: BodyInit | null | undefined,
  contentType: string | null,
  config: BodyCaptureConfig,
): Promise<CaptureOutcome> {
  if (body === null || body === undefined) return NOT_CAPTURED;
  if (config.maxBytes === 0) return { body: null, omitted: 'Body capture cap is 0 bytes' };

  const classification = classifyContentType(contentType, config);
  const cap = config.maxBytes;

  const fromBytes = (bytes: Uint8Array, type: string | null): CaptureOutcome => {
    const truncated = bytes.byteLength > cap;
    const effective = truncated ? bytes.subarray(0, cap) : bytes;
    const effectiveClass = classifyContentType(type, config);
    if (effectiveClass === 'skip') {
      return { body: null, omitted: `Not captured: ${type ?? 'unknown content type'} is treated as binary` };
    }
    return { body: finalise(effective, truncated, type, effectiveClass, config), omitted: null };
  };

  try {
    if (typeof body === 'string') return fromBytes(Buffer.from(body, 'utf8'), contentType);
    if (body instanceof URLSearchParams) {
      return fromBytes(Buffer.from(body.toString(), 'utf8'), contentType ?? 'application/x-www-form-urlencoded');
    }
    if (classification === 'skip') {
      return { body: null, omitted: `Not captured: ${contentType ?? 'unknown content type'} is treated as binary` };
    }
    if (body instanceof ArrayBuffer) return fromBytes(new Uint8Array(body), contentType);
    if (ArrayBuffer.isView(body)) {
      return fromBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType);
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      if (body.size > cap * 4) return { body: null, omitted: `Not captured: blob exceeds ${cap} byte cap` };
      return fromBytes(new Uint8Array(await body.arrayBuffer()), contentType ?? body.type ?? null);
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return { body: null, omitted: 'Not captured: multipart form data' };
    }
    return { body: null, omitted: 'Not captured: streaming request body' };
  } catch (error) {
    return { body: null, omitted: `Body read failed (${error instanceof Error ? error.name : 'unknown'})` };
  }
}

/** Waits for a capture without ever delaying the application request. */
export async function settleCapture(
  capture: Promise<CaptureOutcome> | null,
  timeoutMs: number,
): Promise<CaptureOutcome> {
  if (!capture) return NOT_CAPTURED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<CaptureOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ body: null, omitted: 'Body capture timed out' }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([capture, guard]);
  } catch {
    return { body: null, omitted: 'Body capture failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
