import { useState } from 'react';
import { TraceSpan } from '@apilens/shared-types/trace';

export function useTraces(sessionId: string) {
  const [traces, setTraces] = useState<TraceSpan[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const connect = () => { setIsConnected(true); };
  const disconnect = () => { setIsConnected(false); };

  return { traces, isConnected, connect, disconnect };
}
