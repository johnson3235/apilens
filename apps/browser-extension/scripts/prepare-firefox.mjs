import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chromiumDist = resolve(packageRoot, 'dist');
const firefoxDist = resolve(packageRoot, 'dist-firefox');

if (!existsSync(resolve(chromiumDist, 'manifest.json'))) {
  throw new Error('Build the extension before preparing the Firefox bundle.');
}

// dist-firefox is a generated directory owned solely by this build script.
rmSync(firefoxDist, { recursive: true, force: true });
mkdirSync(firefoxDist, { recursive: true });
cpSync(chromiumDist, firefoxDist, { recursive: true });

const manifestPath = resolve(firefoxDist, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.permissions = manifest.permissions.filter(permission => permission !== 'debugger');
delete manifest.background.service_worker;
manifest.background = { scripts: ['background/service-worker.js'], type: 'module' };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Prepared Firefox WebExtension bundle: ${firefoxDist}`);
