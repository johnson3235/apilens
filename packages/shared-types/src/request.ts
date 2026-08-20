export type RequestSource = 'browser' | 'frontend-server' | 'bff' | 'gateway' | 'internal-service';
export type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
export type RequestType = 'fetch' | 'xhr' | 'graphql' | 'websocket' | 'sse' | 'navigation' | 'form' | 'beacon' | 'static' | 'other';

export interface CapturedRequest {
  id: string;
  sessionId: string;
  source: RequestSource;
  type: RequestType;
  method: RequestMethod;
  url: string;
  path: string;
  hostname: string;
  queryParams: Record<string, string>;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  statusCode: number | null;
  durationMs: number | null;
  startedAt: number; // timestamp ms
  completedAt: number | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  serviceName: string | null;
  scenarioApplied: string | null; // scenario ID if a mock was applied
  error: string | null;
  isClientSide: boolean;
  graphqlOperation: string | null;
  graphqlOperationType: 'query' | 'mutation' | 'subscription' | null;
}

export interface RequestFilter {
  source?: RequestSource[];
  method?: RequestMethod[];
  type?: RequestType[];
  statusCode?: number[];
  search?: string;
  hasError?: boolean;
  isClientSide?: boolean;
}
