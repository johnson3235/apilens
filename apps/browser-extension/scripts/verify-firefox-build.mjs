import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const firefoxRoot = resolve(packageRoot, 'dist-firefox');
const manifestPath = resolve(firefoxRoot, 'manifest.json');
const errors = [];

if (!existsSync(manifestPath)) errors.push('dist-firefox/manifest.json is missing');
let manifest = {};
if (errors.length === 0) manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) errors.push('Firefox manifest must use MV3');
if (manifest.permissions?.includes('debugger')) errors.push('Firefox bundle must not request Chromium debugger permission');
if (manifest.background?.service_worker) errors.push('Firefox bundle must not contain a Chromium service_worker entry');
if (!manifest.background?.scripts?.includes('background/service-worker.js')) errors.push('Firefox background script is missing');
if (!manifest.browser_specific_settings?.gecko?.id) errors.push('Firefox Gecko extension ID is missing');
if (!manifest.content_scripts?.some(script => script.world === 'MAIN')) errors.push('Firefox page-world interceptor entry is missing');

if (errors.length > 0) {
  console.error('Firefox bundle verification failed:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log('ApiLens Firefox MV3 bundle verified.');
}
