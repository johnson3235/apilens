import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chromiumDist = resolve(packageRoot, 'dist');
const safariDist = resolve(packageRoot, 'dist-safari');

if (!existsSync(resolve(chromiumDist, 'manifest.json'))) {
  throw new Error('Build the extension before preparing the Safari bundle.');
}

// dist-safari is a generated directory owned solely by this build script.
rmSync(safariDist, { recursive: true, force: true });
mkdirSync(safariDist, { recursive: true });
cpSync(chromiumDist, safariDist, { recursive: true });

const manifestPath = resolve(safariDist, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.permissions = manifest.permissions.filter(permission => permission !== 'debugger');
delete manifest.browser_specific_settings;

// Safari Web Extensions use a background script rather than Chromium's MV3
// service-worker key. Safari supports module scripts; keep the same runtime.
manifest.background = {
  scripts: ['background/service-worker.js'],
  type: 'module'
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(resolve(safariDist, 'SAFARI-PACKAGING.md'), `# ApiLens Safari package\n\nThis directory is the Safari Web Extension source bundle. On a Mac, package it with:\n\n\`xcrun safari-web-extension-packager ${safariDist} --project-location <output-folder> --app-name ApiLens --swift\`\n\nOpen the generated Xcode project, grant the extension All Websites access, then build and run the containing app. The Chromium network fallback intentionally is not included: Safari uses the page-world engine.\n`);

console.log(`Prepared Safari Web Extension source bundle: ${safariDist}`);
