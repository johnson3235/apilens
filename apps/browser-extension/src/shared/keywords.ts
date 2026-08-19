export interface KeywordFilter {
  id: string;
  keyword: string;
  enabled: boolean;
  color?: string;
  createdAt: number;
}

const STORAGE_KEY = 'apilens_saved_keywords';

const DEFAULT_KEYWORDS: KeywordFilter[] = [
  { id: '1', keyword: 'api', enabled: true, color: '#00E5FF', createdAt: Date.now() },
  { id: '2', keyword: 'auth', enabled: false, color: '#FF9100', createdAt: Date.now() },
  { id: '3', keyword: 'checkout', enabled: false, color: '#00E676', createdAt: Date.now() },
  { id: '4', keyword: 'payment', enabled: false, color: '#E60000', createdAt: Date.now() }
];

export async function loadSavedKeywords(): Promise<KeywordFilter[]> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY] && Array.isArray(data[STORAGE_KEY])) {
      return data[STORAGE_KEY];
    }
  } catch (e) {
    console.error('Error loading saved keywords:', e);
  }
  return DEFAULT_KEYWORDS;
}

export async function saveSavedKeywords(keywords: KeywordFilter[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: keywords });
  } catch (e) {
    console.error('Error saving keywords:', e);
  }
}

export function exportKeywordsToJson(keywords: KeywordFilter[]): void {
  const jsonStr = JSON.stringify(keywords, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `apilens-url-keywords-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseKeywordsFromJson(jsonText: string): KeywordFilter[] {
  const parsed = JSON.parse(jsonText);
  if (Array.isArray(parsed)) {
    return parsed.map(k => ({
      id: k.id || crypto.randomUUID(),
      keyword: k.keyword || '',
      enabled: k.enabled ?? true,
      color: k.color || '#00E5FF',
      createdAt: k.createdAt || Date.now()
    })).filter(k => k.keyword.trim().length > 0);
  }
  throw new Error('Invalid JSON format for keywords');
}
