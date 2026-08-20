import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = resolve(packageRoot, 'dist');
const errors = [];

function requireFile(relativePath) {
  const absolutePath = resolve(distRoot, relativePath);
  try {
    if (!statSync(absolutePath).isFile()) errors.push(`${relativePath} is not a file`);
  } catch {
    errors.push(`${relativePath} is missing`);
  }
  return absolutePath;
}

const requiredFiles = [
  'manifest.json',
  'background/service-worker.js',
  'content/page-interceptor.js',
  'content/content-script.js',
  'devtools/devtools.html',
  'devtools/devtools.js',
  'devtools/panel.html',
  'devtools/panel.js',
  'popup/popup.html',
  'popup/popup.js'
];
requiredFiles.forEach(requireFile);

const manifestPath = requireFile('manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  errors.push(`manifest.json is invalid JSON: ${error.message}`);
  manifest = {};
}

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (manifest.version !== '0.6.1') errors.push('manifest version must be 0.6.1');
if (manifest.background?.service_worker !== 'background/service-worker.js') {
  errors.push('Chromium service_worker entry is missing');
}
if (!manifest.background?.scripts?.includes('background/service-worker.js')) errors.push('cross-browser background script entry is missing');
if (manifest.background?.type !== 'module') errors.push('background must be an ES module');
if (!manifest.browser_specific_settings?.gecko?.id) errors.push('Firefox Gecko extension ID is missing from the shared manifest');
if (!manifest.permissions?.includes('debugger')) errors.push('Chromium CSP fallback requires the debugger permission');

const mainScript = manifest.content_scripts?.find(entry => entry.world === 'MAIN');
const bridgeScript = manifest.content_scripts?.find(entry => entry.world === 'ISOLATED');
for (const [label, entry] of [['MAIN', mainScript], ['ISOLATED', bridgeScript]]) {
  if (!entry) {
    errors.push(`${label} content script is missing`);
    continue;
  }
  if (entry.run_at !== 'document_start') errors.push(`${label} content script must run at document_start`);
  if (!entry.all_frames) errors.push(`${label} content script must run in all frames`);
}

const pageCode = readFileSync(requireFile('content/page-interceptor.js'), 'utf8');
const bridgeCode = readFileSync(requireFile('content/content-script.js'), 'utf8');
const backgroundCode = readFileSync(requireFile('background/service-worker.js'), 'utf8');
const staticContentImport = /(^|[;}]\s*)import\s*(?:[({*'\"])/m;
if (staticContentImport.test(pageCode)) errors.push('MAIN content script contains an unsupported static import');
if (staticContentImport.test(bridgeCode)) errors.push('ISOLATED content script contains an unsupported static import');
if (!pageCode.includes('x-apilens-mocked')) errors.push('mock response marker is missing');
if (!pageCode.includes('rulesRevision')) errors.push('page rule-revision handshake is missing');
if (!backgroundCode.includes('expectedRulesRevision')) errors.push('background rule-revision validation is missing');
if (!backgroundCode.includes('allFrames:!0') && !backgroundCode.includes('allFrames: true')) {
  errors.push('child-frame repair pass is missing');
}

if (errors.length > 0) {
  console.error('ApiLens extension build verification failed:');
  errors.forEach(error => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`ApiLens ${manifest.version} Chromium MV3 build verified for Brave, Chrome, and Edge.`);
  console.log('Verified: page engine, Chromium network fallback, exact rule revision, DevTools, and popup artifacts.');
}
