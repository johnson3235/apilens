import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

check(existsSync(dist), 'dist/ does not exist — run the build first.');

if (existsSync(dist)) {
  const manifestPath = resolve(dist, 'manifest.json');
  check(existsSync(manifestPath), 'manifest.json is missing from dist/.');

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

    check(manifest.manifest_version === 3, 'manifest_version must be 3.');
    check(manifest.version === pkg.version, `manifest version ${manifest.version} does not match package version ${pkg.version}.`);

    const referenced = [
      manifest.background?.service_worker,
      manifest.devtools_page,
      manifest.action?.default_popup,
      ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
      ...Object.values(manifest.icons ?? {}),
    ].filter(Boolean);

    referenced.forEach((file) => {
      const target = resolve(dist, file);
      check(existsSync(target), `manifest references ${file}, which is not present in dist/.`);
      if (existsSync(target)) check(statSync(target).size > 0, `${file} is empty.`);
    });

    const mainWorld = (manifest.content_scripts ?? []).find((entry) => entry.world === 'MAIN');
    check(Boolean(mainWorld), 'A MAIN-world content script is required for page-level interception.');

    // A classic content script cannot execute an ES module; a stray `import`
    // in the built output means the mock engine would silently never install.
    (manifest.content_scripts ?? []).forEach((entry) => {
      (entry.js ?? []).forEach((file) => {
        const target = resolve(dist, file);
        if (!existsSync(target)) return;
        const source = readFileSync(target, 'utf8');
        check(!/^\s*import\s.+from\s/m.test(source), `${file} contains a top-level ES import; content scripts must be self-contained.`);
        check(!/^\s*export\s/m.test(source), `${file} contains a top-level export; content scripts must be self-contained.`);
      });
    });

    const serviceWorker = manifest.background?.service_worker;
    if (serviceWorker) {
      const workerPath = resolve(dist, serviceWorker);
      if (existsSync(workerPath)) {
        const workerSource = readFileSync(resolve(root, 'src/background/service-worker.ts'), 'utf8');
        check(
          !/^(?:(?:var|let|const)\s+[^\r\n=]+\s*=\s*await\b|await\b)/m.test(workerSource),
          `${serviceWorker} contains top-level await; Chromium MV3 service-worker registration will fail.`,
        );
      }
    }
  }

  ['devtools/panel.html', 'devtools/panel.js', 'popup/popup.html', 'popup/popup.js'].forEach((file) => {
    check(existsSync(resolve(dist, file)), `${file} is missing from dist/.`);
  });
}

if (failures.length > 0) {
  console.error('Extension build verification failed:');
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log('Extension build verified: manifest, entry points and content-script isolation are all correct.');
