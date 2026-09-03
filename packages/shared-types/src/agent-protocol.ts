import type { CapturedRequest } from './request';
import type { ReplayRequest, ReplayResponse } from './replay';
import type { Rule } from './rule';
import type { QaSession, SessionMarker } from './session';
import type { TraceSpan } from './trace';

export const AGENT_PROTOCOL_VERSION = 1;

export const DEFAULT_AGENT_PORT = 7317;
export const DEFAULT_AGENT_HOST = '127.0.0.1';

/** Who is on the other end of a socket. Determines what messages are allowed. */
export type AgentPeerRole = 'extension' | 'automation' | 'sdk';

export interface AgentHello {
  type: 'hello';
  protocolVersion: number;
  role: AgentPeerRole;
  clientName: string;
  clientVersion: string;
  /** Shared token printed by the agent on startup. */
  token: string;
  sessionId: string | null;
}

export interface AgentWelcome {
  type: 'welcome';
  protocolVersion: number;
  agentVersion: string;
  sessionId: string;
  /** Capabilities the agent actually has in this run, so the UI can adapt. */
  capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  traceAggregation: boolean;
  serverSpanIngest: boolean;
  mockProxy: boolean;
  replay: boolean;
  evidenceExport: boolean;
  /** Proxy listeners currently running, keyed by route id. */
  proxyRoutes: Array<{ id: string; listenPort: number; target: string }>;
}

export interface AgentError {
  type: 'error';
  code:
    | 'unauthorized'
    | 'protocol-version'
    | 'bad-request'
    | 'not-found'
    | 'internal'
    | 'rate-limited';
  message: string;
  /** Correlates the error with the request that caused it. */
  requestId: string | null;
}

/* ------------------------------------------------------------------ */
/* Extension → Agent                                                   */
/* ------------------------------------------------------------------ */

export interface StartSessionMessage {
  type: 'session:start';
  requestId: string;
  session: QaSession;
}

export interface StopSessionMessage {
  type: 'session:stop';
  requestId: string;
  sessionId: string;
}

export interface PushRequestsMessage {
  type: 'requests:push';
  sessionId: string;
  requests: CapturedRequest[];
}

export interface PushMarkerMessage {
  type: 'session:marker';
  sessionId: string;
  marker: SessionMarker;
}

export interface SyncRulesMessage {
  type: 'rules:sync';
  requestId: string;
  sessionId: string;
  rules: Rule[];
}

export interface ReplayMessage {
  type: 'replay:execute';
  requestId: string;
  sessionId: string;
  originalRequestId: string;
  request: ReplayRequest;
}

export interface ExportEvidenceMessage {
  type: 'evidence:export';
  requestId: string;
  sessionId: string;
  formats: string[];
  outputDir: string | null;
}

export interface GetSnapshotMessage {
  type: 'session:snapshot';
  requestId: string;
  sessionId: string;
}

/* ------------------------------------------------------------------ */
/* SDK / backend → Agent                                               */
/* ------------------------------------------------------------------ */

export interface PushSpansMessage {
  type: 'spans:push';
  sessionId: string;
  spans: TraceSpan[];
}

/* ------------------------------------------------------------------ */
/* Agent → clients                                                     */
/* ------------------------------------------------------------------ */

export interface SpansUpdateMessage {
  type: 'spans:update';
  sessionId: string;
  spans: TraceSpan[];
}

export interface RequestsUpdateMessage {
  type: 'requests:update';
  sessionId: string;
  requests: CapturedRequest[];
}

export interface RulesUpdateMessage {
  type: 'rules:update';
  sessionId: string;
  rules: Rule[];
}

export interface AckMessage {
  type: 'ack';
  requestId: string;
  ok: true;
}

export interface ReplayResultMessage {
  type: 'replay:result';
  requestId: string;
  originalRequestId: string;
  response: ReplayResponse;
}

export interface EvidenceResultMessage {
  type: 'evidence:result';
  requestId: string;
  files: Array<{ format: string; path: string; bytes: number }>;
}

export interface SnapshotResultMessage {
  type: 'session:snapshot:result';
  requestId: string;
  sessionId: string;
  requests: CapturedRequest[];
  spans: TraceSpan[];
}

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

export type ClientToAgentMessage =
  | AgentHello
  | StartSessionMessage
  | StopSessionMessage
  | PushRequestsMessage
  | PushMarkerMessage
  | PushSpansMessage
  | SyncRulesMessage
  | ReplayMessage
  | ExportEvidenceMessage
  | GetSnapshotMessage
  | PingMessage;

export type AgentToClientMessage =
  | AgentWelcome
  | AgentError
  | AckMessage
  | SpansUpdateMessage
  | RequestsUpdateMessage
  | RulesUpdateMessage
  | ReplayResultMessage
  | EvidenceResultMessage
  | SnapshotResultMessage
  | PongMessage;

export type AgentConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unauthorized'
  | 'incompatible';

export interface AgentStatus {
  state: AgentConnectionState;
  agentVersion: string | null;
  capabilities: AgentCapabilities | null;
  lastError: string | null;
  connectedAt: number | null;
}
