import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import { Gateway } from './gateway.js';
import { RedisPubSub } from './redis-pubsub.js';

const PORT = parseInt(process.env.PORT || '3002', 10);

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ApiLens Realtime Gateway\n');
});

const wss = new WebSocketServer({ server });
const gateway = new Gateway();
const pubsub = new RedisPubSub();

pubsub.onMessage((channel, message) => {
  // channel format: session:{sessionId}:traces
  const parts = channel.split(':');
  if (parts.length === 3 && parts[0] === 'session' && parts[2] === 'traces') {
    const sessionId = parts[1];
    try {
      const data = JSON.parse(message);
      gateway.broadcast(sessionId, { type: 'traces_update', data });
    } catch (e) {
      console.error('Failed to parse redis message', e);
    }
  }
});

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  
  // Extract sessionId from /ws/sessions/:sessionId
  const match = url.pathname.match(/^\/ws\/sessions\/([a-zA-Z0-9-]+)$/);
  
  if (!match) {
    ws.close(1008, 'Invalid endpoint');
    return;
  }
  
  const sessionId = match[1];
  console.log(`Client connected to session: ${sessionId}`);
  
  // Custom property for heartbeat
  (ws as any).isAlive = true;
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });
  
  gateway.addConnection(sessionId, ws);
  pubsub.subscribe(`session:${sessionId}:traces`);
  
  ws.on('close', () => {
    console.log(`Client disconnected from session: ${sessionId}`);
    gateway.removeConnection(sessionId, ws);
    
    // If no more clients for this session, unsubscribe
    if (!gateway.hasConnections(sessionId)) {
      pubsub.unsubscribe(`session:${sessionId}:traces`);
    }
  });
  
  ws.on('error', console.error);
});

// Heartbeat interval
const interval = setInterval(() => {
  gateway.handleHeartbeat();
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`Realtime Gateway listening on port ${PORT}`);
});
