/**
 * End-to-end test of the Server API workspace against a real instrumented app.
 *
 * Needs the demo stack running with the Next SDK control plane enabled:
 *
 *   pnpm --filter @apilens/demo-api-server dev
 *   APILENS_ENABLED=true APILENS_CONTROL_TOKEN=<24+ chars> pnpm --filter @apilens/demo-nextjs-app dev
 *
 * Loads the built extension, links it to the app's control plane, drives the
 * checkout journey, and verifies server capture (incoming route + upstream
 * calls, payloads, redaction) and a server mock created from a captured call.
 * Set APILENS_SHOTS to a directory to save a screenshot of each step.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../dist');
const APP = process.env.APILENS_APP ?? 'http://localhost:3000';
const TOKEN = process.env.APILENS_CONTROL_TOKEN ?? '';
const SHOTS = process.env.APILENS_SHOTS ?? '';
const CHROME = process.env.APILENS_CHROME
  ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');

// playwright-core is not a workspace dependency; allow pointing at an install elsewhere.
const { chromium } = await import(process.env.APILENS_PLAYWRIGHT ? pathToFileURL(process.env.APILENS_PLAYWRIGHT).href : 'playwright-core');

let failures = 0;
function check(name, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

let shotIndex = 0;
async function shot(page, name) {
  if (!SHOTS) return;
  shotIndex += 1;
  await page.screenshot({ path: join(SHOTS, `${String(shotIndex).padStart(2, '0')}-${name}.png`) });
}

async function control(path, init = {}) {
  const response = await fetch(`${APP}/api/__apilens${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return response.json();
}

async function checkout() {
  const response = await fetch(`${APP}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 59.98, customerId: '1', cardNumber: '4111111111111111' }),
  });
  return { status: response.status, body: await response.json() };
}

if (TOKEN.length < 24) {
  console.error('Set APILENS_CONTROL_TOKEN to the token the demo app was started with.');
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'apilens-server-e2e-'));
let context;
try {
  const health = await control('/health');
  check('control plane reachable', health.ok === true, `${health.serviceName} · SDK ${health.sdkVersion}`);
  await control('/calls', { method: 'DELETE' });
  await control('/rules', { method: 'DELETE' });

  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    viewport: { width: 1440, height: 860 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/devtools/panel.html`, { waitUntil: 'load' });
  await panel.waitForSelector('.qa-shell');

  // Link the panel to the instrumented server, as Settings → Instrumented server does.
  const saved = await panel.evaluate(async ({ url, token }) => {
    const current = await chrome.runtime.sendMessage({ type: 'settings:get' });
    const settings = { ...current.settings, serverControl: { ...current.settings.serverControl, enabled: true, url, token } };
    return chrome.runtime.sendMessage({ type: 'settings:set', settings });
  }, { url: APP, token: TOKEN });
  check('server link saved', saved?.ok === true);

  // Drive the real journey in a browser tab: products page, then checkout + pay.
  const app = await context.newPage();
  await app.goto(`${APP}/`, { waitUntil: 'networkidle' });
  await app.goto(`${APP}/checkout`, { waitUntil: 'networkidle' });
  await shot(app, 'demo-app-checkout');
  const pay = app.getByRole('button', { name: /pay|complete|place/i }).first();
  if (await pay.count()) {
    await pay.click();
    await app.waitForTimeout(1_200);
  }
  await shot(app, 'demo-app-paid');
  // A direct call too, carrying a field the SDK is configured to redact.
  await checkout();

  await panel.bringToFront();
  // The first-run tour covers the panel; it is exercised by extension.e2e.mjs.
  if (await panel.locator('.tour-dialog').count() > 0) {
    await panel.keyboard.press('Escape');
    await panel.waitForSelector('.tour-dialog', { state: 'detached' });
  }
  await panel.locator('.nav-item', { hasText: 'Server API' }).click();
  await panel.waitForSelector('.server-view .vrow', { timeout: 15_000 });
  await panel.waitForTimeout(2_500);
  await shot(panel, 'server-calls');

  const calls = (await control('/calls?since=0&limit=500')).calls;
  const route = calls.find((call) => call.kind === 'server' && call.path === '/api/checkout');
  const payment = calls.find((call) => call.kind === 'client' && call.path === '/api/payments');
  const customer = calls.find((call) => call.kind === 'client' && call.path.startsWith('/api/customers/'));
  check('incoming route captured', Boolean(route), route ? `${route.method} ${route.path} ${route.statusCode}` : '');
  check('upstream calls captured', Boolean(payment && customer));
  check('upstream calls are children of the route',
    Boolean(route && payment && payment.traceId === route.traceId && payment.parentSpanId === route.spanId));
  check('request payload captured', Boolean(payment?.requestBody?.content?.includes('59.98')));
  check('response payload captured', Boolean(payment?.responseBody?.content?.includes('completed')));
  // The page's own Pay button sends no card; the scripted checkout above does.
  const withCard = calls.filter((call) => call.requestBody?.content?.includes('cardNumber'));
  check('card number redacted', withCard.length >= 2
    && withCard.every((call) => call.requestBody.content.includes('[REDACTED]'))
    && !JSON.stringify(calls).includes('4111111111111111'), `${withCard.length} calls carried the field`);

  const rows = await panel.locator('.server-view .vrow').count();
  check('panel lists server calls', rows >= 4, `${rows} rows`);

  // Inspect the upstream payment call.
  await panel.locator('.server-view .vrow', { hasText: '/api/payments' }).first().click();
  await panel.waitForSelector('.detail-tabs');
  await panel.getByRole('tab', { name: /^Sent/ }).click();
  await shot(panel, 'payment-request-payload');
  await panel.getByRole('tab', { name: /^Received/ }).click();
  await shot(panel, 'payment-response');

  // Mock it the way a tester would: Simulate a problem → Service is down → Save and turn on.
  await panel.getByRole('button', { name: 'Simulate a problem' }).click();
  await panel.getByRole('radio', { name: /Service is down/ }).click();
  await shot(panel, 'mock-editor');
  await panel.getByRole('button', { name: 'Save and turn on' }).click();
  await panel.waitForSelector('.rule-card .switch.on', { timeout: 10_000 });
  await shot(panel, 'mock-enabled');

  const rules = (await control('/rules')).rules ?? [];
  check('rule saved to server, on, for the next call only',
    rules.length === 1 && rules[0].enabled === true && rules[0].applyMode === 'once',
    rules[0] ? `${rules[0].match.method} ${rules[0].match.urlPattern} · ${rules[0].applyMode}` : 'no rules');

  // Repeat the journey: the BFF now sees a broken payment service.
  const mocked = await checkout();
  check('checkout reflects the mocked upstream', mocked.status === 503, `HTTP ${mocked.status} ${JSON.stringify(mocked.body).slice(0, 80)}`);
  const after = (await control('/calls?since=0&limit=500')).calls;
  const mockedCall = after.find((call) => call.path === '/api/payments' && call.mockedBy);
  check('mocked call is marked in the capture', Boolean(mockedCall), mockedCall ? `mockedBy ${mockedCall.mockedBy}` : '');

  await panel.getByRole('tab', { name: /^Calls/ }).click();
  await panel.waitForTimeout(2_500);
  await shot(panel, 'server-calls-mocked');

  // A one-shot rule stops by itself: the next journey reaches the real backend.
  const next = await checkout();
  check('one-shot mock fires only once', next.status === 200, `HTTP ${next.status}`);
  await control('/rules', { method: 'DELETE' });
} catch (error) {
  failures += 1;
  console.log(`FAIL  unexpected error — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await context?.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'All server checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
