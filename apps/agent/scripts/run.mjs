import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'dist/cli.js');

if (!existsSync(entry)) {
  console.error('ApiLens agent is not built yet. Run "pnpm --filter @apilens/agent build" first.');
  process.exit(1);
}

await import(pathToFileURL(entry).href);
