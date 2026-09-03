import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_HOST, DEFAULT_AGENT_PORT } from '@apilens/shared-types';

export interface ProxyRouteConfig {
  id: string;
  /** Port the QA proxy listens on. */
  listenPort: number;
  /** Origin the proxy forwards to, e.g. `https://payments.qa.internal`. */
  target: string;
  /** Environment id used for the safety gate on proxied traffic. */
  environmentId: string;
}

export interface AgentConfig {
  host: string;
  port: number;
  token: string;
  /** Directory for evidence exports and optional session persistence. */
  dataDir: string;
  outputDir: string;
  /** Sessions kept in memory before the oldest is evicted. */
  maxSessions: number;
  maxRequestsPerSession: number;
  maxSpansPerSession: number;
  autoDeleteAfterDays: number;
  proxyRoutes: ProxyRouteConfig[];
  /** Persist sessions to disk so an agent restart does not lose evidence. */
  persistSessions: boolean;
}

export const AGENT_VERSION = '1.0.0';

function defaultDataDir(): string {
  return join(homedir(), '.apilens');
}

export function tokenFilePath(dataDir: string): string {
  return join(dataDir, 'agent-token');
}

/**
 * Loads (or creates) the shared token.
 *
 * The agent is localhost-only, but a token still matters: any web page running
 * in the browser could otherwise reach `http://127.0.0.1:7317` and read
 * captured traffic. The token lives in the user profile with the file created
 * fresh on first run.
 */
export function loadOrCreateToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = tokenFilePath(dataDir);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export interface AgentConfigFile {
  host?: string;
  port?: number;
  token?: string;
  dataDir?: string;
  outputDir?: string;
  maxSessions?: number;
  maxRequestsPerSession?: number;
  maxSpansPerSession?: number;
  autoDeleteAfterDays?: number;
  persistSessions?: boolean;
  proxyRoutes?: ProxyRouteConfig[];
}

export interface CliOptions {
  config?: string;
  output?: string;
  port?: number;
  host?: string;
  proxy?: string[];
  help?: boolean;
  version?: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    switch (arg) {
      case '--config':
        options.config = next;
        index += 1;
        break;
      case '--output':
      case '-o':
        options.output = next;
        index += 1;
        break;
      case '--port':
      case '-p':
        options.port = Number(next);
        index += 1;
        break;
      case '--host':
        options.host = next;
        index += 1;
        break;
      case '--proxy':
        options.proxy = [...(options.proxy ?? []), next ?? ''];
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.version = true;
        break;
      default:
        break;
    }
  }
  return options;
}

/** Parses `--proxy 8081:https://payments.qa.internal:qa`. */
export function parseProxySpec(spec: string): ProxyRouteConfig | null {
  const match = /^(\d+):(https?:\/\/[^:]+(?::\d+)?)(?::([a-z0-9_-]+))?$/i.exec(spec.trim());
  if (!match) return null;
  return {
    id: `proxy-${match[1]}`,
    listenPort: Number(match[1]),
    target: match[2]!.replace(/\/$/, ''),
    environmentId: match[3] ?? 'qa',
  };
}

export function loadConfig(options: CliOptions = {}): AgentConfig {
  let file: AgentConfigFile = {};
  if (options.config && existsSync(options.config)) {
    try {
      file = JSON.parse(readFileSync(options.config, 'utf8')) as AgentConfigFile;
    } catch (error) {
      throw new Error(`Could not read config file ${options.config}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const dataDir = file.dataDir ?? process.env.APILENS_DATA_DIR ?? defaultDataDir();
  const cliProxies = (options.proxy ?? [])
    .map(parseProxySpec)
    .filter((route): route is ProxyRouteConfig => route !== null);

  return {
    host: options.host ?? file.host ?? process.env.APILENS_AGENT_HOST ?? DEFAULT_AGENT_HOST,
    port: options.port ?? file.port ?? Number(process.env.APILENS_AGENT_PORT ?? DEFAULT_AGENT_PORT),
    token: file.token ?? process.env.APILENS_AGENT_TOKEN ?? loadOrCreateToken(dataDir),
    dataDir,
    outputDir: options.output ?? file.outputDir ?? join(dataDir, 'evidence'),
    maxSessions: file.maxSessions ?? 25,
    maxRequestsPerSession: file.maxRequestsPerSession ?? 20_000,
    maxSpansPerSession: file.maxSpansPerSession ?? 50_000,
    autoDeleteAfterDays: file.autoDeleteAfterDays ?? 7,
    persistSessions: file.persistSessions ?? false,
    proxyRoutes: [...(file.proxyRoutes ?? []), ...cliProxies],
  };
}

export const HELP_TEXT = `
apilens-agent — local QA tracing, mocking and evidence agent

Usage:
  apilens-agent [options]

Options:
  -p, --port <port>        Port to listen on (default ${DEFAULT_AGENT_PORT})
      --host <host>        Interface to bind (default ${DEFAULT_AGENT_HOST}, loopback only)
      --config <file>      JSON config file
  -o, --output <dir>       Directory for exported evidence
      --proxy <spec>       Start a QA reverse proxy: <port>:<target-origin>[:<environment>]
                           e.g. --proxy 8081:https://payments.qa.internal:qa
  -h, --help               Show this help
  -v, --version            Show the agent version

The agent binds to loopback only and requires the shared token stored in
<dataDir>/agent-token. It never sends data anywhere outside this machine.
`.trim();
