import { build, context } from 'esbuild';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/**
 * Workspace packages are published as TypeScript source, so the agent is
 * bundled rather than compiled file-by-file. Node built-ins and `ws` stay
 * external so the bundle remains small and debuggable.
 */
const options = {
  entryPoints: [resolve(root, 'src/cli.ts'), resolve(root, 'src/index.ts')],
  outdir: resolve(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  external: ['ws'],
  banner: {
    js: "import { createRequire as __apilensCreateRequire } from 'node:module';const require = __apilensCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('ApiLens agent: watching for changes…');
} else {
  await build(options);
  const cli = resolve(root, 'dist/cli.js');
  if (existsSync(cli) && process.platform !== 'win32') chmodSync(cli, 0o755);
  console.log('ApiLens agent built to dist/.');
}
