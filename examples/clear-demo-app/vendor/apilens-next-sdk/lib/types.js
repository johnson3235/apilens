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
exports.CONTROL_PROTOCOL_VERSION = void 0;
exports.CONTROL_PROTOCOL_VERSION = 2;
//# sourceMappingURL=types.js.map