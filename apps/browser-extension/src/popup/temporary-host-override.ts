import type { ExtensionSettings } from '../shared/settings';

export function withTemporaryHostOverride(settings: ExtensionSettings, hostnameInput: string, now = Date.now()): ExtensionSettings {
  const hostname = hostnameInput.trim().toLowerCase();
  if (!hostname) throw new Error('A hostname is required for a temporary override.');
  const environmentId = `temporary-${hostname.replace(/[^a-z0-9]+/g, '-')}`;
  const environment = { id: environmentId, name: `Temporary · ${hostname}`, kind: 'prod' as const, hostPatterns: [hostname], baseUrls: [`https://${hostname}`], mockingAllowed: false, proxyTarget: null, traceIdHeaders: [], correlationIdHeaders: [], additionalRedactedHeaders: [] };
  const environments = [...settings.environments.environments.filter((item) => item.id !== environmentId), environment];
  const overrides = [...settings.environments.overrides.filter((item) => item.environmentId !== environmentId), { environmentId, grantedAt: now, expiresAt: now + 10 * 60_000, reason: `Exact-host browser mock testing for ${hostname}` }];
  return { ...settings, environments: { ...settings.environments, environments, overrides } };
}
