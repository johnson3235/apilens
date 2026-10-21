import type { BodyCaptureOptions, CapturedBody } from './types';
/**
 * Bounded payload capture.
 *
 * Every function here follows one rule: the application's own stream is never
 * consumed. Bodies are read from a `clone()` branch, capped, and abandoned as
 * soon as the cap is hit, so instrumenting a large download cannot turn into
 * an out-of-memory incident.
 */
export declare const DEFAULT_TEXT_CONTENT_TYPES: string[];
export interface BodyCaptureConfig {
    request: boolean;
    response: boolean;
    maxBytes: number;
    contentTypes: string[];
    redactKeys: string[];
    includeBinary: boolean;
}
export declare function resolveBodyCapture(options: BodyCaptureOptions | undefined): BodyCaptureConfig;
type Classification = 'text' | 'binary' | 'skip';
export declare function classifyContentType(contentType: string | null, config: BodyCaptureConfig): Classification;
export interface CaptureOutcome {
    body: CapturedBody | null;
    /** Human-readable explanation shown in the UI when `body` is null. */
    omitted: string | null;
}
/**
 * Captures a `Request`/`Response` payload from a throwaway clone.
 *
 * Returns immediately with an explanation instead of throwing: a body we could
 * not read must never turn into a failed application request.
 */
export declare function captureMessageBody(message: Request | Response, config: BodyCaptureConfig): Promise<CaptureOutcome>;
/**
 * Captures an outgoing `RequestInit.body` without constructing a `Request`.
 *
 * Constructing one would consume a stream body and force callers to supply
 * `duplex`, so each supported shape is read directly and streams are reported
 * as intentionally skipped.
 */
export declare function captureInitBody(body: BodyInit | null | undefined, contentType: string | null, config: BodyCaptureConfig): Promise<CaptureOutcome>;
/** Waits for a capture without ever delaying the application request. */
export declare function settleCapture(capture: Promise<CaptureOutcome> | null, timeoutMs: number): Promise<CaptureOutcome>;
export {};
//# sourceMappingURL=bodies.d.ts.map