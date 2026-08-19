import { WebSocket } from 'ws';

export class Gateway {
  private sessions: Map<string, Set<WebSocket>> = new Map();

  addConnection(sessionId: string, ws: WebSocket) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }
    this.sessions.get(sessionId)!.add(ws);
  }

  removeConnection(sessionId: string, ws: WebSocket) {
    const sessionConnections = this.sessions.get(sessionId);
    if (sessionConnections) {
      sessionConnections.delete(ws);
      if (sessionConnections.size === 0) {
        this.sessions.delete(sessionId);
      }
    }
  }

  hasConnections(sessionId: string): boolean {
    return this.sessions.has(sessionId) && this.sessions.get(sessionId)!.size > 0;
  }

  broadcast(sessionId: string, data: any) {
    const sessionConnections = this.sessions.get(sessionId);
    if (sessionConnections) {
      const message = JSON.stringify(data);
      for (const client of sessionConnections) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }

  handleHeartbeat() {
    for (const [sessionId, clients] of this.sessions.entries()) {
      for (const ws of clients) {
        const client = ws as any;
        if (client.isAlive === false) {
          this.removeConnection(sessionId, ws);
          ws.terminate();
          continue;
        }
        client.isAlive = false;
        ws.ping();
      }
    }
  }
}
