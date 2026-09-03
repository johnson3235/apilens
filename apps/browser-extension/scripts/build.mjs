import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/**
 * Every entry point is bundled standalone.
 *
 * MV3 content scripts run as classic scripts, so a shared ES-module chunk
 * between entries would silently fail to load in the page. Independent bundles
 * remove that whole class of bug at the cost of a little duplication.
 */
const entries = [
  { in: 'src/background/service-worker.ts', out: 'background/service-worker', format: 'esm' },
  { in: 'src/content/page-interceptor.ts', out: 'content/page-interceptor', format: 'iife' },
  { in: 'src/content/bridge.ts', out: 'content/bridge', format: 'iife' },
  { in: 'src/devtools/devtools.ts', out: 'devtools/devtools', format: 'iife' },
  { in: 'src/devtools/panel.tsx', out: 'devtools/panel', format: 'iife' },
  { in: 'src/popup/popup.tsx', out: 'popup/popup', format: 'iife' },
];

const staticFiles = [
  ['src/devtools/devtools.html', 'devtools/devtools.html'],
  ['src/devtools/panel.html', 'devtools/panel.html'],
  ['src/styles/panel.css', 'devtools/panel.css'],
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/styles/panel.css', 'popup/panel.css'],
  ['src/manifest.json', 'manifest.json'],
];

function copyStatic() {
  mkdirSync(resolve(dist, 'devtools'), { recursive: true });
  mkdirSync(resolve(dist, 'popup'), { recursive: true });
  mkdirSync(resolve(dist, 'icons'), { recursive: true });

  staticFiles.forEach(([from, to]) => {
    cpSync(resolve(root, from), resolve(dist, to));
  });

  const icons = resolve(root, 'src/icons');
  if (existsSync(icons)) cpSync(icons, resolve(dist, 'icons'), { recursive: true });

  // Keep the manifest version aligned with package.json so a release can never
  // ship a mismatched pair.
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const manifestPath = resolve(dist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function optionsFor(entry) {
  return {
    entryPoints: [resolve(root, entry.in)],
    outfile: resolve(dist, `${entry.out}.js`),
    bundle: true,
    format: entry.format,
    target: ['chrome116', 'edge116'],
    platform: 'browser',
    jsx: 'automatic',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': dev ? '"development"' : '"production"',
      __APILENS_VERSION__: JSON.stringify(
        JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
      ),
    },
    loader: { '.css': 'empty' },
    logLevel: 'warning',
  };
}

if (watch) {
  copyStatic();
  const contexts = await Promise.all(entries.map((entry) => context(optionsFor(entry))));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('ApiLens extension: watching for changes…');
} else {
  copyStatic();
  await Promise.all(entries.map((entry) => build(optionsFor(entry))));
  console.log(`ApiLens extension built to ${dist}`);
}
