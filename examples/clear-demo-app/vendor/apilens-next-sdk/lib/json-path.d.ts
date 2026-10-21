/**
 * Minimal dotted/bracket path access.
 *
 * Deliberately tiny and dependency-free: the SDK ships standalone, so it
 * cannot reuse `@apilens/core`. Prototype-polluting segments are rejected
 * because rule payloads arrive over the control plane.
 */
export declare function parsePath(path: string): string[];
export declare function getPath(root: unknown, path: string): unknown;
export type PathOperation = 'set' | 'delete' | 'nullify';
/** Mutates `root` in place and reports whether anything actually changed. */
export declare function applyPath(root: unknown, path: string, operation: PathOperation, value?: unknown): boolean;
export declare function coerceType(value: unknown, target: string): unknown;
//# sourceMappingURL=json-path.d.ts.map