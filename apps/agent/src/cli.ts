#!/usr/bin/env node
import { AGENT_VERSION, HELP_TEXT, loadConfig, parseCliArgs } from './config';
import { startAgent } from './server';

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }
  if (options.version) {
    console.log(AGENT_VERSION);
    return;
  }

  const config = loadConfig(options);
  const handle = await startAgent(config);

  const shutdown = (signal: string): void => {
    console.log(`\nReceived ${signal}, shutting down ApiLens agent.`);
    void handle.close().then(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(`ApiLens agent failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
