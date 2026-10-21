"use strict";
/**
 * Minimal dotted/bracket path access.
 *
 * Deliberately tiny and dependency-free: the SDK ships standalone, so it
 * cannot reuse `@apilens/core`. Prototype-polluting segments are rejected
 * because rule payloads arrive over the control plane.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePath = parsePath;
exports.getPath = getPath;
exports.applyPath = applyPath;
exports.coerceType = coerceType;
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
function parsePath(path) {
    const segments = [];
    const pattern = /[^.[\]]+/g;
    let match;
    while ((match = pattern.exec(path)) !== null)
        segments.push(match[0]);
    return segments;
}
function isContainer(value) {
    return typeof value === 'object' && value !== null;
}
function getPath(root, path) {
    let current = root;
    for (const segment of parsePath(path)) {
        if (!isContainer(current) || BLOCKED.has(segment))
            return undefined;
        current = current[segment];
    }
    return current;
}
/** Mutates `root` in place and reports whether anything actually changed. */
function applyPath(root, path, operation, value) {
    const segments = parsePath(path);
    if (segments.length === 0)
        return false;
    if (segments.some((segment) => BLOCKED.has(segment)))
        return false;
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
        if (!isContainer(parent))
            return false;
        const next = parent[segment];
        if (!isContainer(next)) {
            if (operation !== 'set')
                return false;
            const created = {};
            parent[segment] = created;
            parent = created;
            continue;
        }
        parent = next;
    }
    if (!isContainer(parent))
        return false;
    const leaf = segments[segments.length - 1];
    if (Array.isArray(parent)) {
        const index = Number(leaf);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length)
            return false;
        if (operation === 'delete')
            parent.splice(index, 1);
        else
            parent[index] = operation === 'nullify' ? null : value;
        return true;
    }
    const record = parent;
    if (operation === 'delete') {
        if (!(leaf in record))
            return false;
        delete record[leaf];
        return true;
    }
    record[leaf] = operation === 'nullify' ? null : value;
    return true;
}
function coerceType(value, target) {
    switch (target) {
        case 'string':
            return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        case 'number': {
            const parsed = Number(value);
            return Number.isNaN(parsed) ? 0 : parsed;
        }
        case 'boolean':
            return Boolean(value);
        case 'null':
            return null;
        case 'array':
            return Array.isArray(value) ? value : value === undefined ? [] : [value];
        case 'object':
            return isContainer(value) && !Array.isArray(value) ? value : {};
        default:
            return value;
    }
}
//# sourceMappingURL=json-path.js.map