const HEX = '0123456789abcdef';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return output;
}

/** RFC 4122 v4 identifier, used for entity ids. */
export function createId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 32 hex characters, matching the W3C trace context `trace-id` format. */
export function createTraceId(): string {
  return toHex(randomBytes(16));
}

/** 16 hex characters, matching the W3C trace context `span-id` format. */
export function createSpanId(): string {
  return toHex(randomBytes(8));
}

/** Short, human-friendly id for UI labels such as `Trace 392ae4`. */
export function shortId(value: string, length = 6): string {
  const cleaned = value.replace(/-/g, '');
  return cleaned.slice(0, length);
}

/**
 * Deterministic 32-bit hash. Used for grouping, fingerprints and stable ids —
 * never for security decisions.
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
