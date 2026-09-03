import type { CapturedBody, RequestMethod } from './request';

export interface ReplayRequest {
  method: RequestMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** Milliseconds before the replay is aborted. */
  timeoutMs: number;
  /** Whether cookies/credentials should be sent. Off by default for safety. */
  includeCredentials: boolean;
  followRedirects: boolean;
}

export interface ReplayResponse {
  statusCode: number | null;
  statusText: string | null;
  headers: Record<string, string>;
  body: CapturedBody | null;
  durationMs: number;
  error: string | null;
  /** Where the replay was executed from. */
  executedBy: 'extension' | 'agent';
}

export interface ReplayResult {
  id: string;
  originalRequestId: string;
  request: ReplayRequest;
  response: ReplayResponse;
  executedAt: number;
}

export type CodeTarget = 'curl' | 'fetch' | 'axios' | 'playwright' | 'python-requests' | 'rest-assured';

export interface CodeGenOptions {
  target: CodeTarget;
  /** Include headers that the redaction policy masked. Off by default. */
  includeRedactedHeaders: boolean;
  /** Emit a multi-line, readable form. */
  pretty: boolean;
  /** Shell quoting flavour for cURL. */
  shell: 'bash' | 'powershell';
}

export const DEFAULT_CODEGEN_OPTIONS: CodeGenOptions = {
  target: 'curl',
  includeRedactedHeaders: false,
  pretty: true,
  shell: 'bash',
};
