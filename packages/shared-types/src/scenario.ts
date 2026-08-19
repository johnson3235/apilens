export type ScenarioStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface Scenario {
  id: string;
  projectId: string;
  name: string;
  description: string;
  status: ScenarioStatus;
  rules: string[]; // rule IDs
  tags: string[];
  version: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScenarioExport {
  scenario: Scenario;
  rules: import('./rule').Rule[];
  exportedAt: number;
  format: string;
  version: string;
}

export interface PlaywrightExport {
  routes: Array<{
    urlPattern: string;
    method: string;
    handler: string; // generated code
  }>;
}
