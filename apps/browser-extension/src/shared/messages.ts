import type {
  AgentStatus,
  ApiCatalog,
  Bookmark,
  CapturedRequest,
  ContractSet,
  EvidenceExportOptions,
  EvidenceScenario,
  QaSession,
  ReplayRequest,
  ReplayResponse,
  ResponseAssertion,
  Rule,
  SessionMarker,
  TraceSpan,
} from '@apilens/shared-types';
import type { ExtensionSettings } from './settings';
import type { MockEngineHealth } from './engine-health';

/**
 * Every message crossing an extension boundary is described here.
 *
 * A single discriminated union means the service worker, DevTools panel and
 * popup cannot drift apart: adding a message without handling it is a
 * compile-time error rather than a silent runtime no-op.
 */
export type PanelRequest =
  | { type: 'state:get'; tabId: number | null }
  | { type: 'requests:get'; tabId: number | null; sessionId: string | null }
  | { type: 'recent:get'; tabId: number | null }
  | { type: 'requests:clear'; tabId: number | null }
  | { type: 'spans:get'; sessionId: string | null }
  | { type: 'rules:get' }
  | { type: 'rules:set'; rules: Rule[]; tabId: number | null }
  | { type: 'settings:get' }
  | { type: 'settings:set'; settings: ExtensionSettings }
  | { type: 'session:start'; name: string; tabId: number | null }
  | { type: 'session:stop' }
  | { type: 'session:marker'; marker: SessionMarker }
  | { type: 'session:evidence:set'; title: string; scenarios: EvidenceScenario[]; activeScenarioId: string | null }
  | { type: 'session:screenshot'; tabId: number | null; label: string; scenarioId: string | null }
  | { type: 'session:list' }
  | { type: 'session:load'; sessionId: string }
  | { type: 'session:delete'; sessionId: string }
  | { type: 'session:clearAll' }
  | { type: 'engine:health'; tabId: number | null }
  | { type: 'engine:repair'; tabId: number | null }
  | { type: 'replay:execute'; originalRequestId: string; request: ReplayRequest; viaAgent: boolean }
  | { type: 'evidence:export'; sessionId: string; options: Partial<EvidenceExportOptions> }
  | { type: 'agent:status' }
  | { type: 'agent:connect' }
  | { type: 'agent:disconnect' }
  | { type: 'bookmarks:set'; bookmarks: Bookmark[] }
  | { type: 'bookmarks:get' }
  | { type: 'catalog:get' }
  | { type: 'assertions:get' }
  | { type: 'assertions:set'; assertions: ResponseAssertion[] }
  | { type: 'contracts:get' }
  | { type: 'contracts:set'; contracts: ContractSet[] };

export interface PanelState {
  version: string;
  session: QaSession | null;
  recording: boolean;
  settings: ExtensionSettings;
  rules: Rule[];
  agent: AgentStatus;
  engine: MockEngineHealth | null;
  environmentId: string | null;
  environmentName: string | null;
  mockingAllowed: boolean;
  mockingBlockedReason: string | null;
  pageUrl: string | null;
}

export type PanelResponse =
  | { ok: true; state: PanelState }
  | { ok: true; requests: CapturedRequest[] }
  | { ok: true; spans: TraceSpan[] }
  | { ok: true; rules: Rule[] }
  | { ok: true; settings: ExtensionSettings }
  | { ok: true; sessions: QaSession[] }
  | { ok: true; health: MockEngineHealth }
  | { ok: true; agent: AgentStatus }
  | { ok: true; response: ReplayResponse }
  | { ok: true; files: Array<{ format: string; name: string; content: string }> }
  | { ok: true; bookmarks: Bookmark[] }
  | { ok: true; catalog: ApiCatalog }
  | { ok: true; assertions: ResponseAssertion[] }
  | { ok: true; contracts: ContractSet[] }
  | { ok: true }
  | { ok: false; error: string };

/** Pushed from the service worker to any open panel or popup. */
export type PanelEvent =
  | { type: 'event:requests'; tabId: number | null; requests: CapturedRequest[] }
  | { type: 'event:spans'; spans: TraceSpan[] }
  | { type: 'event:state'; state: PanelState }
  | { type: 'event:agent'; agent: AgentStatus }
  | { type: 'event:console'; tabId: number; level: 'error' | 'warning' | 'info'; text: string; timestamp: number };

/** Messages exchanged between the ISOLATED bridge and the MAIN-world hooks. */
export interface BridgeToPageMessage {
  source: 'apilens-bridge';
  type: 'rules' | 'self-test' | 'settings';
  rules?: Rule[];
  revision?: string;
  requestId?: string;
  captureBodies?: boolean;
  maxBodyBytes?: number;
  mockingAllowed?: boolean;
}

export interface PageToBridgeMessage {
  source: 'apilens-page';
  type: 'ready' | 'status' | 'request' | 'self-test-result' | 'console';
  status?: PageHookStatus;
  request?: CapturedRequest;
  requestId?: string;
  result?: { ok: boolean; error?: string; testedAt: number };
  level?: 'error' | 'warning' | 'info';
  text?: string;
  timestamp?: number;
}

export interface PageHookStatus {
  installed: boolean;
  fetchPatched: boolean;
  xhrPatched: boolean;
  beaconPatched: boolean;
  websocketPatched: boolean;
  eventSourcePatched: boolean;
  ruleCount: number;
  ruleRevision: string;
  version: string;
  updatedAt: number;
}
