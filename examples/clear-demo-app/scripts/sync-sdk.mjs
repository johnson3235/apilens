// Refreshes vendor/apilens-next-sdk from the monorepo's sdks/next build.
// Run `pnpm --filter @apilens/next-sdk build` first, then `npm run sdk:sync` and `npm install`.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdk = resolve(here, '../../../sdks/next');
const target = resolve(here, '../vendor/apilens-next-sdk');

if (!existsSync(join(sdk, 'dist', 'index.js'))) {
  console.error(`No SDK build at ${join(sdk, 'dist')}. Run: pnpm --filter @apilens/next-sdk build`);
  process.exit(1);
}

const source = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// "lib", not "dist": the repo's .gitignore drops every dist/ folder, and Vercel builds from git.
cpSync(join(sdk, 'dist'), join(target, 'lib'), { recursive: true, filter: (path) => !path.endsWith('.map') && !path.includes('__tests__') });
writeFileSync(join(target, 'package.json'), `${JSON.stringify({
  name: source.name,
  version: source.version,
  description: `${source.description} (vendored copy for the CLEAR demo app)`,
  main: 'lib/index.js',
  types: 'lib/index.d.ts',
  engines: source.engines,
}, null, 2)}\n`);
console.log(`Vendored ${source.name}@${source.version} into ${target}`);
