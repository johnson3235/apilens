export interface TabCandidate { id?: number; url?: string }

export function selectActiveWebTabId(currentWindow: TabCandidate[], lastFocusedWindow: TabCandidate[]): number | null {
  const webTab = [...currentWindow, ...lastFocusedWindow].find((tab) => tab.id !== undefined && /^https?:/i.test(tab.url ?? ''));
  return webTab?.id ?? null;
}

export function isUnsupportedRecentRequest(response: { ok?: boolean; error?: string } | undefined): boolean {
  return response?.ok !== true && /unsupported request.*recent:get/i.test(response?.error ?? '');
}

export function isMixedBuild(popupVersion: string, workerVersion: string): boolean {
  return popupVersion !== workerVersion;
}
