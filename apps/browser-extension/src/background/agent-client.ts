import type {
  AgentCapabilities,
  AgentStatus,
  AgentToClientMessage,
  CapturedRequest,
  ClientToAgentMessage,
  QaSession,
  ReplayRequest,
  ReplayResponse,
  Rule,
  TraceSpan,
} from '@apilens/shared-types';
import { AGENT_PROTOCOL_VERSION } from '@apilens/shared-types';
import { createId } from '@apilens/core';
import { EXTENSION_VERSION } from '../shared/browser-api';
import { agentWebSocketUrl, type AgentSettings } from '../shared/settings';

export interface AgentClientEvents {
  onSpans(sessionId: string, spans: TraceSpan[]): void;
  onRequests(sessionId: string, requests: CapturedRequest[]): void;
  onStatusChange(status: AgentStatus): void;
}

interface Pending {
  resolve: (message: AgentToClientMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * WebSocket client for the QA local agent.
 *
 * The agent is optional: everything the extension can see on its own keeps
 * working when the agent is absent. When it *is* present the client streams
 * browser traffic to it and receives server-side spans back, which is what
 * makes a single end-to-end trace possible.
 */
export class AgentClient {
  private socket: WebSocket | null = null;
  private settings: AgentSettings | null = null;
  private sessionId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, Pending>();
  private status: AgentStatus = { state: 'disconnected', agentVersion: null, capabilities: null, lastError: null, connectedAt: null };
  private intentionalClose = false;

  constructor(private readonly events: AgentClientEvents) {}

  getStatus(): AgentStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.status.state === 'connected';
  }

  capabilities(): AgentCapabilities | null {
    return this.status.capabilities;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  connect(settings: AgentSettings, sessionId: string | null): void {
    this.settings = settings;
    this.sessionId = sessionId;
    this.intentionalClose = false;

    if (!settings.enabled) {
      this.disconnect();
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;

    this.updateStatus({ state: 'connecting', lastError: null });

    let socket: WebSocket;
    try {
      socket = new WebSocket(agentWebSocketUrl(settings));
    } catch (error) {
      this.updateStatus({ state: 'disconnected', lastError: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.send({
        type: 'hello',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        role: 'extension',
        clientName: 'ApiLens Extension',
        clientVersion: EXTENSION_VERSION,
        token: settings.token,
        sessionId: this.sessionId,
      });
    };

    socket.onmessage = (event) => this.handleMessage(String(event.data));

    socket.onclose = (event) => {
      this.socket = null;
      const wasUnauthorized = event.code === 4401;
      const wasIncompatible = event.code === 4400;
      this.rejectAllPending(new Error('The agent connection closed.'));
      this.updateStatus({
        state: wasUnauthorized ? 'unauthorized' : wasIncompatible ? 'incompatible' : 'disconnected',
        connectedAt: null,
        lastError: wasUnauthorized
          ? 'The agent rejected the token. Copy the token printed by the agent into Settings.'
          : wasIncompatible
            ? 'The agent and extension speak different protocol versions. Update both to the same release.'
            : this.status.lastError,
      });
      if (!this.intentionalClose && !wasUnauthorized && !wasIncompatible) this.scheduleReconnect();
    };

    socket.onerror = () => {
      this.updateStatus({ lastError: `Could not reach the QA agent at ${agentWebSocketUrl(settings)}.` });
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.rejectAllPending(new Error('Disconnected from the agent.'));
    try {
      this.socket?.close(1000, 'Client disconnect');
    } catch {
      // Already closed.
    }
    this.socket = null;
    this.updateStatus({ state: 'disconnected', agentVersion: null, capabilities: null, connectedAt: null });
  }

  pushRequests(sessionId: string, requests: CapturedRequest[]): void {
    if (!this.isConnected() || requests.length === 0) return;
    this.send({ type: 'requests:push', sessionId, requests });
  }

  pushSpans(sessionId: string, spans: TraceSpan[]): void {
    if (!this.isConnected() || spans.length === 0) return;
    this.send({ type: 'spans:push', sessionId, spans });
  }

  startSession(session: QaSession): void {
    if (!this.isConnected()) return;
    this.sessionId = session.id;
    this.send({ type: 'session:start', requestId: createId(), session });
  }

  stopSession(sessionId: string): void {
    if (!this.isConnected()) return;
    this.send({ type: 'session:stop', requestId: createId(), sessionId });
  }

  syncRules(sessionId: string, rules: Rule[]): void {
    if (!this.isConnected()) return;
    this.send({ type: 'rules:sync', requestId: createId(), sessionId, rules });
  }

  async replay(sessionId: string, originalRequestId: string, request: ReplayRequest): Promise<ReplayResponse> {
    const message = await this.request({ type: 'replay:execute', requestId: createId(), sessionId, originalRequestId, request });
    if (message.type !== 'replay:result') throw new Error('Agent returned an unexpected reply to the replay request.');
    return message.response;
  }

  async exportEvidence(sessionId: string, formats: string[], outputDir: string | null) {
    const message = await this.request({ type: 'evidence:export', requestId: createId(), sessionId, formats, outputDir });
    if (message.type !== 'evidence:result') throw new Error('Agent returned an unexpected reply to the evidence export.');
    return message.files;
  }

  private request(message: ClientToAgentMessage & { requestId: string }): Promise<AgentToClientMessage> {
    if (!this.isConnected()) return Promise.reject(new Error('The QA agent is not connected.'));

    return new Promise<AgentToClientMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error('The QA agent did not respond in time.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(message.requestId, { resolve, reject, timer });
      this.send(message);
    });
  }

  private send(message: ClientToAgentMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.updateStatus({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleMessage(raw: string): void {
    let message: AgentToClientMessage;
    try {
      message = JSON.parse(raw) as AgentToClientMessage;
    } catch {
      return;
    }

    switch (message.type) {
      case 'welcome':
        this.reconnectAttempt = 0;
        this.updateStatus({
          state: 'connected',
          agentVersion: message.agentVersion,
          capabilities: message.capabilities,
          connectedAt: Date.now(),
          lastError: null,
        });
        return;

      case 'spans:update':
        this.events.onSpans(message.sessionId, message.spans);
        return;

      case 'requests:update':
        this.events.onRequests(message.sessionId, message.requests);
        return;

      case 'error': {
        if (message.requestId) {
          const pending = this.pending.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            pending.reject(new Error(message.message));
            return;
          }
        }
        this.updateStatus({ lastError: message.message });
        return;
      }

      case 'replay:result':
      case 'evidence:result':
      case 'session:snapshot:result':
      case 'ack': {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.resolve(message);
        return;
      }

      default:
        return;
    }
  }

  private rejectAllPending(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (!this.settings?.enabled || !this.settings.autoReconnect) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    // Exponential backoff keeps a missing agent from generating a connection
    // storm while the QA engineer is mid-session.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (this.settings) this.connect(this.settings, this.sessionId);
    }, delay);
  }

  private updateStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch };
    this.events.onStatusChange(this.status);
  }
}
