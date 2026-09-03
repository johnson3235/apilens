import type {
  EnvironmentPolicy,
  RedactionPolicy,
  RetentionPolicy,
  TraceHeaderConfig,
} from '@apilens/shared-types';
import {
  DEFAULT_AGENT_HOST,
  DEFAULT_AGENT_PORT,
  DEFAULT_ENVIRONMENT_POLICY,
  DEFAULT_RETENTION_POLICY,
  DEFAULT_TRACE_HEADER_CONFIG,
} from '@apilens/shared-types';
import { DEFAULT_REDACTION_POLICY } from '@apilens/security';
import { extensionApi } from './browser-api';

export type ThemePreference = 'dark' | 'light' | 'system';

export interface AgentSettings {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  /** Reconnect automatically after the agent restarts. */
  autoReconnect: boolean;
}

export interface CaptureSettings {
  /** Record request/response bodies. Disabling reduces memory dramatically. */
  captureBodies: boolean;
  maxBodyBytes: number;
  /** Keep static asset traffic. Off by default — this is an API tool. */
  captureStaticAssets: boolean;
  /** Inject `traceparent` into same-origin requests so backends can join. */
  injectTraceHeaders: boolean;
}

export interface ExtensionSettings {
  theme: ThemePreference;
  capture: CaptureSettings;
  redaction: RedactionPolicy;
  environments: EnvironmentPolicy;
  traceHeaders: TraceHeaderConfig;
  retention: RetentionPolicy;
  agent: AgentSettings;
  slowRequestMs: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  theme: 'dark',
  capture: {
    captureBodies: true,
    maxBodyBytes: 256 * 1024,
    captureStaticAssets: false,
    injectTraceHeaders: false,
  },
  redaction: DEFAULT_REDACTION_POLICY,
  environments: DEFAULT_ENVIRONMENT_POLICY,
  traceHeaders: DEFAULT_TRACE_HEADER_CONFIG,
  retention: DEFAULT_RETENTION_POLICY,
  agent: {
    enabled: false,
    host: DEFAULT_AGENT_HOST,
    port: DEFAULT_AGENT_PORT,
    token: '',
    autoReconnect: true,
  },
  slowRequestMs: 1_000,
};

const SETTINGS_KEY = 'apilens.settings.v1';

/**
 * Merges stored settings over the defaults.
 *
 * Deep-merging matters here: a settings object written by an older version
 * must never remove a newly-added safety default such as a redaction rule.
 */
export function mergeSettings(stored: unknown): ExtensionSettings {
  if (!stored || typeof stored !== 'object') return DEFAULT_SETTINGS;
  const raw = stored as Partial<ExtensionSettings>;

  return {
    theme: raw.theme ?? DEFAULT_SETTINGS.theme,
    capture: { ...DEFAULT_SETTINGS.capture, ...raw.capture },
    redaction: {
      ...DEFAULT_SETTINGS.redaction,
      ...raw.redaction,
      rules: mergeRedactionRules(raw.redaction?.rules),
    },
    environments: {
      ...DEFAULT_SETTINGS.environments,
      ...raw.environments,
      environments: raw.environments?.environments ?? DEFAULT_SETTINGS.environments.environments,
      overrides: raw.environments?.overrides ?? [],
    },
    traceHeaders: { ...DEFAULT_SETTINGS.traceHeaders, ...raw.traceHeaders },
    retention: { ...DEFAULT_SETTINGS.retention, ...raw.retention },
    agent: { ...DEFAULT_SETTINGS.agent, ...raw.agent },
    slowRequestMs: raw.slowRequestMs ?? DEFAULT_SETTINGS.slowRequestMs,
  };
}

function mergeRedactionRules(stored: RedactionPolicy['rules'] | undefined): RedactionPolicy['rules'] {
  if (!stored) return DEFAULT_SETTINGS.redaction.rules;
  const storedById = new Map(stored.map((rule) => [rule.id, rule]));
  const builtIn = DEFAULT_SETTINGS.redaction.rules.map((rule) => {
    const override = storedById.get(rule.id);
    // Built-in rules keep their patterns; only the enabled flag is user-owned.
    return override ? { ...rule, enabled: override.enabled } : rule;
  });
  const custom = stored.filter((rule) => !rule.builtIn && !DEFAULT_SETTINGS.redaction.rules.some((item) => item.id === rule.id));
  return [...builtIn, ...custom];
}

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const stored = await extensionApi.storage.local.get(SETTINGS_KEY);
    return mergeSettings(stored[SETTINGS_KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await extensionApi.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function onSettingsChanged(callback: (settings: ExtensionSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    callback(mergeSettings(changes[SETTINGS_KEY].newValue));
  };
  extensionApi.storage.onChanged.addListener(listener);
  return () => extensionApi.storage.onChanged.removeListener(listener);
}

export function agentWebSocketUrl(agent: AgentSettings): string {
  return `ws://${agent.host}:${agent.port}/ws`;
}

export function agentHttpUrl(agent: AgentSettings): string {
  return `http://${agent.host}:${agent.port}`;
}
