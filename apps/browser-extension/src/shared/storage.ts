import type { Rule, Scenario, Session } from '@apilens/shared-types';
import { extensionApi } from './browser-api';

const STORAGE_KEYS = {
  RULES: 'apilens_rules',
  SCENARIOS: 'apilens_scenarios',
  SESSION: 'apilens_session',
};

export async function saveRules(rules: Rule[]): Promise<void> {
  await extensionApi.storage.local.set({ [STORAGE_KEYS.RULES]: rules });
}

export async function loadRules(): Promise<Rule[]> {
  const data = await extensionApi.storage.local.get(STORAGE_KEYS.RULES);
  return data[STORAGE_KEYS.RULES] || [];
}

export async function saveScenarios(scenarios: Scenario[]): Promise<void> {
  await extensionApi.storage.local.set({ [STORAGE_KEYS.SCENARIOS]: scenarios });
}

export async function loadScenarios(): Promise<Scenario[]> {
  const data = await extensionApi.storage.local.get(STORAGE_KEYS.SCENARIOS);
  return data[STORAGE_KEYS.SCENARIOS] || [];
}

export async function saveSession(session: Session): Promise<void> {
  await extensionApi.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
}

export async function loadSession(): Promise<Session | null> {
  const data = await extensionApi.storage.local.get(STORAGE_KEYS.SESSION);
  return data[STORAGE_KEYS.SESSION] || null;
}

export async function clearAll(): Promise<void> {
  await extensionApi.storage.local.clear();
}

// Export Rules to JSON file on local disk
export function exportRulesToJson(rules: Rule[]): void {
  const dataStr = JSON.stringify(rules, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `apilens-qa-mock-rules-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// Parse Rules from JSON text imported from local disk
export function parseRulesFromJson(jsonText: string): Rule[] {
  const parsed = JSON.parse(jsonText);
  if (Array.isArray(parsed)) {
    return parsed.map(r => ({
      id: r.id || crypto.randomUUID(),
      scenarioId: r.scenarioId || '',
      name: r.name || 'Imported Rule',
      description: r.description || '',
      enabled: r.enabled ?? true,
      priority: r.priority || 1,
      conditions: r.conditions || [],
      conditionLogic: r.conditionLogic || 'and',
      action: r.action || { type: 'status-code', statusCode: 500 },
      applyMode: r.applyMode || 'always',
      appliedCount: r.appliedCount || 0,
      createdAt: r.createdAt || Date.now(),
      updatedAt: Date.now()
    }));
  }
  throw new Error('Invalid JSON format for rules array');
}
