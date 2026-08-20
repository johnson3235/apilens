import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const safariRoot = resolve(packageRoot, 'dist-safari');
const manifestPath = resolve(safariRoot, 'manifest.json');
const errors = [];

if (!existsSync(manifestPath)) errors.push('dist-safari/manifest.json is missing');
let manifest = {};
if (errors.length === 0) manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) errors.push('Safari manifest must use MV3');
if (manifest.permissions?.includes('debugger')) errors.push('Safari bundle must not request Chromium debugger permission');
if (manifest.background?.service_worker) errors.push('Safari bundle must not contain a Chromium service_worker entry');
if (!manifest.background?.scripts?.includes('background/service-worker.js')) errors.push('Safari background script is missing');
if (!manifest.content_scripts?.some(script => script.world === 'MAIN')) errors.push('Safari page-world interceptor entry is missing');
for (const file of ['content/page-interceptor.js', 'content/content-script.js', 'popup/popup.js', 'devtools/panel.js']) {
  if (!existsSync(resolve(safariRoot, file))) errors.push(`Safari bundle file missing: ${file}`);
}

if (errors.length > 0) {
  console.error('Safari bundle verification failed:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log('ApiLens Safari Web Extension source bundle verified. Package it on macOS with Safari Web Extension Packager.');
}
