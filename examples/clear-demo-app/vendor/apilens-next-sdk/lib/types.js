"use strict";
/**
 * Wire types shared between the server SDK and the ApiLens browser extension.
 *
 * This file must stay dependency-free: the Next SDK ships as a standalone
 * tarball, so it cannot import `@apilens/shared-types`. The extension keeps a
 * structurally identical copy in `shared/server-control.ts`; changing a field
 * here means changing it there too.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIDDLEWARE_HEADER = exports.CONTROL_PROTOCOL_VERSION = void 0;
exports.CONTROL_PROTOCOL_VERSION = 2;
/**
 * Request header the Edge wrapper adds to the request it lets through:
 * `<traceId>-<spanId>` of the middleware run, so the page continues its trace
 * and the extension can show the middleware under it.
 */
exports.MIDDLEWARE_HEADER = 'x-apilens-middleware';
//# sourceMappingURL=types.js.map