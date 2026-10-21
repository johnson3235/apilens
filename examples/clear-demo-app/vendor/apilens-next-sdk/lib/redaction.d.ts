/**
 * Redaction applied before anything leaves the application process.
 *
 * The server SDK sees real customer traffic, so redaction runs on the write
 * path — not in the UI. A value that was never buffered cannot leak through an
 * evidence export, a screenshot or a shared HAR file.
 */
export declare const REDACTED = "[REDACTED]";
export declare function isSensitiveHeader(name: string): boolean;
export declare function redactHeaders(headers: Headers | Record<string, string> | null): Record<string, string>;
export declare function redactQuery(params: URLSearchParams): Record<string, string>;
export interface RedactionResult<T> {
    value: T;
    redacted: boolean;
}
/**
 * Redacts a textual payload.
 *
 * JSON is walked structurally so a sensitive key is removed even when its
 * value would not match a pattern. Anything else falls back to value-shape
 * redaction, which still catches tokens embedded in form posts and XML.
 */
export declare function redactBody(text: string, contentType: string | null, extraRedactKeys?: string[]): {
    text: string;
    redacted: boolean;
};
/** Strips credentials and query values from a URL before it is recorded. */
export declare function safeUrlParts(value: string): {
    url: string;
    origin: string;
    path: string;
    query: Record<string, string>;
};
//# sourceMappingURL=redaction.d.ts.map