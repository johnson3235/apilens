import type { Rule } from './rule';

export type ScenarioStatus = 'draft' | 'active' | 'archived';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  status: ScenarioStatus;
  ruleIds: string[];
  tags: string[];
  /** Environments the scenario is intended for. */
  environments: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ScenarioExport {
  formatVersion: 1;
  scenario: Scenario;
  rules: Rule[];
  exportedAt: number;
  /** Always true — bundles never carry credentials. */
  secretsExcluded: true;
}
