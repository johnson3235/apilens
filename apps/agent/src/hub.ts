import type { WebSocket, WebSocketServer } from 'ws';
import type {
  AgentCapabilities,
  AgentPeerRole,
  AgentToClientMessage,
  ClientToAgentMessage,
  CapturedRequest,
  TraceSpan,
} from '@apilens/shared-types';
import { AGENT_PROTOCOL_VERSION } from '@apilens/shared-types';
import { executeReplay } from '@apilens/replay-engine';
import { AGENT_VERSION } from './config';
import type { SessionStore } from './store';
import type { EvidenceWriter } from './evidence-writer';

interface Peer {
  socket: WebSocket;
  role: AgentPeerRole;
  clientName: string;
  sessionId: string | null;
  authenticated: boolean;
  alive: boolean;
}

export interface HubOptions {
  token: string;
  store: SessionStore;
  evidenceWriter: EvidenceWriter;
  capabilities: AgentCapabilities;
  log?: (message: string) => void;
}

/**
 * The agent's WebSocket hub.
 *
 * Every peer must complete an authenticated `hello` handshake before any other
 * message is accepted. Broadcasts are scoped to the session a peer subscribed
 * to, so two parallel QA sessions never see each other's traffic.
 */
export class AgentHub {
  private readonly peers = new Set<Peer>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: HubOptions) {}

  attach(server: WebSocketServer): void {
    server.on('connection', (socket) => this.handleConnection(socket));
    this.heartbeat = setInterval(() => this.checkHeartbeats(), 30_000);
    this.heartbeat.unref?.();
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.peers.forEach((peer) => peer.socket.close(1001, 'Agent shutting down'));
    this.peers.clear();
  }

  peerCount(): number {
    return this.peers.size;
  }

  handleConnection(socket: WebSocket): void {
    const peer: Peer = {
      socket,
      role: 'extension',
      clientName: 'unknown',
      sessionId: null,
      authenticated: false,
      alive: true,
    };
    this.peers.add(peer);

    socket.on('pong', () => {
      peer.alive = true;
    });

    socket.on('message', (data: unknown) => {
      void this.handleMessage(peer, String(data));
    });

    socket.on('close', () => {
      this.peers.delete(peer);
    });

    socket.on('error', () => {
      this.peers.delete(peer);
      try {
        socket.close();
      } catch {
        // Socket already torn down.
      }
    });
  }

  private send(peer: Peer, message: AgentToClientMessage): void {
    if (peer.socket.readyState !== 1) return;
    try {
      peer.socket.send(JSON.stringify(message));
    } catch (error) {
      this.options.log?.(`Failed to send to ${peer.clientName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Broadcasts to every authenticated peer subscribed to a session. */
  broadcast(sessionId: string, message: AgentToClientMessage, exclude?: Peer): void {
    this.peers.forEach((peer) => {
      if (peer === exclude) return;
      if (!peer.authenticated) return;
      if (peer.sessionId !== null && peer.sessionId !== sessionId) return;
      this.send(peer, message);
    });
  }

  broadcastSpans(sessionId: string, spans: TraceSpan[]): void {
    if (spans.length === 0) return;
    this.broadcast(sessionId, { type: 'spans:update', sessionId, spans });
  }

  broadcastRequests(sessionId: string, requests: CapturedRequest[]): void {
    if (requests.length === 0) return;
    this.broadcast(sessionId, { type: 'requests:update', sessionId, requests });
  }

  private async handleMessage(peer: Peer, raw: string): Promise<void> {
    let message: ClientToAgentMessage;
    try {
      message = JSON.parse(raw) as ClientToAgentMessage;
    } catch {
      this.send(peer, { type: 'error', code: 'bad-request', message: 'Message was not valid JSON.', requestId: null });
      return;
    }

    if (message.type === 'hello') {
      this.handleHello(peer, message);
      return;
    }

    if (!peer.authenticated) {
      this.send(peer, { type: 'error', code: 'unauthorized', message: 'Send a hello message with a valid token first.', requestId: null });
      peer.socket.close(4401, 'Unauthorized');
      return;
    }

    switch (message.type) {
      case 'ping':
        this.send(peer, { type: 'pong' });
        return;

      case 'session:start': {
        this.options.store.startSession(message.session);
        peer.sessionId = message.session.id;
        this.send(peer, { type: 'ack', requestId: message.requestId, ok: true });
        return;
      }

      case 'session:stop': {
        this.options.store.stopSession(message.sessionId);
        this.send(peer, { type: 'ack', requestId: message.requestId, ok: true });
        return;
      }

      case 'requests:push': {
        const stored = this.options.store.addRequests(message.sessionId, message.requests);
        this.broadcast(message.sessionId, { type: 'requests:update', sessionId: message.sessionId, requests: stored }, peer);
        return;
      }

      case 'spans:push': {
        const stored = this.options.store.addSpans(message.sessionId, message.spans);
        this.broadcast(message.sessionId, { type: 'spans:update', sessionId: message.sessionId, spans: stored }, peer);
        return;
      }

      case 'session:marker': {
        this.options.store.addMarker(message.sessionId, message.marker);
        return;
      }

      case 'rules:sync': {
        this.options.store.setRules(message.sessionId, message.rules);
        this.broadcast(message.sessionId, { type: 'rules:update', sessionId: message.sessionId, rules: message.rules }, peer);
        this.send(peer, { type: 'ack', requestId: message.requestId, ok: true });
        return;
      }

      case 'session:snapshot': {
        this.send(peer, {
          type: 'session:snapshot:result',
          requestId: message.requestId,
          sessionId: message.sessionId,
          requests: this.options.store.requests(message.sessionId),
          spans: this.options.store.spans(message.sessionId),
        });
        return;
      }

      case 'replay:execute': {
        const response = await executeReplay(message.request, { executedBy: 'agent' });
        this.send(peer, {
          type: 'replay:result',
          requestId: message.requestId,
          originalRequestId: message.originalRequestId,
          response,
        });
        return;
      }

      case 'evidence:export': {
        try {
          const files = await this.options.evidenceWriter.export(message.sessionId, message.formats, message.outputDir);
          this.send(peer, { type: 'evidence:result', requestId: message.requestId, files });
        } catch (error) {
          this.send(peer, {
            type: 'error',
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            requestId: message.requestId,
          });
        }
        return;
      }

      default:
        this.send(peer, {
          type: 'error',
          code: 'bad-request',
          message: `Unsupported message type "${(message as { type: string }).type}".`,
          requestId: null,
        });
    }
  }

  private handleHello(peer: Peer, message: Extract<ClientToAgentMessage, { type: 'hello' }>): void {
    if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      this.send(peer, {
        type: 'error',
        code: 'protocol-version',
        message: `Agent speaks protocol v${AGENT_PROTOCOL_VERSION} but the client sent v${message.protocolVersion}. Update the extension or the agent.`,
        requestId: null,
      });
      peer.socket.close(4400, 'Protocol mismatch');
      return;
    }

    if (message.token !== this.options.token) {
      this.send(peer, {
        type: 'error',
        code: 'unauthorized',
        message: 'Invalid agent token. Copy the token printed by the agent into ApiLens settings.',
        requestId: null,
      });
      peer.socket.close(4401, 'Unauthorized');
      return;
    }

    peer.authenticated = true;
    peer.role = message.role;
    peer.clientName = message.clientName;
    peer.sessionId = message.sessionId;

    const sessionId = message.sessionId ?? this.options.store.activeSessionId() ?? '';
    this.send(peer, {
      type: 'welcome',
      protocolVersion: AGENT_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      sessionId,
      capabilities: this.options.capabilities,
    });
    this.options.log?.(`${message.clientName} (${message.role}) connected.`);
  }

  private checkHeartbeats(): void {
    this.peers.forEach((peer) => {
      if (!peer.alive) {
        this.peers.delete(peer);
        try {
          peer.socket.terminate();
        } catch {
          // Already gone.
        }
        return;
      }
      peer.alive = false;
      try {
        peer.socket.ping();
      } catch {
        this.peers.delete(peer);
      }
    });
  }
}
