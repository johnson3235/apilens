type WebExtensionGlobal = typeof globalThis & { browser?: typeof chrome };

// Firefox exposes Promise-first WebExtension APIs as `browser`; Chromium exposes
// the same modern Promise APIs as `chrome`. Runtime code that awaits API calls
// must use this selected namespace instead of assuming Chromium semantics.
export const extensionApi: typeof chrome = (globalThis as WebExtensionGlobal).browser ?? chrome;
