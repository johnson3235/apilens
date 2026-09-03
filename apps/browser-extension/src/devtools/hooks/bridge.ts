import type { PanelEvent, PanelRequest, PanelResponse, PanelState } from '../../shared/messages';
import { extensionApi } from '../../shared/browser-api';

export function inspectedTabId(): number | null {
  return chrome.devtools?.inspectedWindow?.tabId ?? null;
}

/**
 * Typed request/response bridge to the service worker.
 *
 * Every failure is surfaced as a rejected promise with a readable message so
 * the UI can show *why* something did not work instead of silently doing
 * nothing — the single most common complaint about QA tooling.
 */
export async function send<T extends PanelResponse>(message: PanelRequest): Promise<T> {
  let response: PanelResponse | null;
  try {
    response = (await extensionApi.runtime.sendMessage(message)) as PanelResponse | null;
  } catch (error) {
    throw new Error(
      `ApiLens background service is not reachable (${error instanceof Error ? error.message : String(error)}). Reload the extension from chrome://extensions.`,
    );
  }
  if (!response) throw new Error('ApiLens background service did not respond. Reload the page and try again.');
  if (!response.ok) throw new Error(response.error);
  return response as T;
}

export function subscribe(handler: (event: PanelEvent) => void): () => void {
  const listener = (message: unknown): void => {
    const event = message as PanelEvent | undefined;
    if (!event || typeof event.type !== 'string' || !event.type.startsWith('event:')) return;
    handler(event);
  };
  extensionApi.runtime.onMessage.addListener(listener);
  return () => extensionApi.runtime.onMessage.removeListener(listener);
}

export async function fetchState(): Promise<PanelState> {
  const response = await send<{ ok: true; state: PanelState }>({ type: 'state:get', tabId: inspectedTabId() });
  return response.state;
}

/** Triggers a browser download from the panel context. */
export function downloadFile(name: string, contentType: string, content: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function readFileAsText(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
