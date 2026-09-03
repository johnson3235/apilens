type WebExtensionGlobal = typeof globalThis & { browser?: typeof chrome };

/**
 * Firefox exposes Promise-first WebExtension APIs as `browser`; Chromium
 * exposes the same modern Promise APIs as `chrome`. Runtime code that awaits
 * API calls must use this selected namespace instead of assuming Chromium.
 */
export const extensionApi: typeof chrome = (globalThis as WebExtensionGlobal).browser ?? chrome;

export const EXTENSION_VERSION: string =
  typeof __APILENS_VERSION__ === 'string' ? __APILENS_VERSION__ : '0.0.0';

declare const __APILENS_VERSION__: string | undefined;

export function isChromiumDebuggerAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.debugger?.attach === 'function';
}

/** Swallows the "no receiving end" noise that MV3 messaging produces routinely. */
export async function sendRuntimeMessage<T = unknown>(message: unknown): Promise<T | null> {
  try {
    return (await extensionApi.runtime.sendMessage(message)) as T;
  } catch {
    return null;
  }
}

export async function sendTabMessage<T = unknown>(tabId: number, message: unknown): Promise<T | null> {
  try {
    return (await extensionApi.tabs.sendMessage(tabId, message)) as T;
  } catch {
    return null;
  }
}
