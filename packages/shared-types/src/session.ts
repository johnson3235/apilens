export interface Session {
  id: string;
  userId: string;
  projectId: string;
  environmentId: string;
  browserSessionId: string;
  pageUrl: string;
  userAgent: string;
  startedAt: number;
  endedAt: number | null;
  requestCount: number;
  traceCount: number;
  activeScenarios: string[];
}

export interface SessionSummary {
  id: string;
  pageUrl: string;
  startedAt: number;
  requestCount: number;
  traceCount: number;
  errorCount: number;
}
