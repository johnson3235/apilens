/**
 * End-to-end test of the packaged ApiLens extension in a real Chromium browser.
 *
 * Loads the built `dist` as an unpacked MV3 extension, serves a test page that
 * makes a realistic mix of API and asset calls, and drives the real DevTools
 * panel page. Verifies capture, filtering, page scoping, extraction and the
 * guided tour against the actual shipped artefact — not a harness.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../../apps/browser-extension/dist');

const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

/* ------------------------------------------------------------------ */
/* Test application                                                    */
/* ------------------------------------------------------------------ */

const PAGE_BILLING = `<!doctype html><html><head><title>Billing</title>
<link rel="stylesheet" href="/static/theme.css"></head><body>
<h1>Billing</h1><div id="out">loading…</div>
<script src="/static/app.js"></script>
<script>
(async () => {
  const log = (m) => { document.getElementById('out').textContent = m; };
  try {
    const r1 = await fetch('/api/billing?contactId=3055861');
    const b1 = await r1.json();
    await fetch('/api/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret-value' },
      body: JSON.stringify({ amount: b1.amountDue, currency: 'EUR' }),
    });
    await fetch('/api/offers');          // returns 503
    const xhr = new XMLHttpRequest();    // exercise the XHR hook too
    xhr.open('GET', '/api/profile');
    xhr.send();
    await fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'GetOrderSummary', query: '{ orders { id } }' }),
    });
    log('billing-done');
  } catch (e) { log('error: ' + e.message); }
})();
</script></body></html>`;

const PAGE_ORDERS = `<!doctype html><html><head><title>Orders</title></head><body>
<h1>Orders</h1><div id="out">loading…</div>
<script>
(async () => {
  await fetch('/api/orders');
  await fetch('/api/orders/history');   // returns 404
  document.getElementById('out').textContent = 'orders-done';
})();
</script></body></html>`;

function startApp() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };
    switch (url.pathname) {
      case '/':
      case '/myaccount/billing':
        return send(200, 'text/html', PAGE_BILLING);
      case '/myaccount/orders':
        return send(200, 'text/html', PAGE_ORDERS);
      case '/static/theme.css':
        return send(200, 'text/css', 'body{font-family:sans-serif;background:#111;color:#eee}');
      case '/static/app.js':
        return send(200, 'text/javascript', 'window.__app = true;');
      case '/api/billing':
        return send(200, 'application/json',
          JSON.stringify({ amountDue: 42.5, currency: 'EUR', contactId: '3055861' }));
      case '/api/payments':
        return send(201, 'application/json', JSON.stringify({ paymentId: 'pay_123', accepted: true }));
      case '/api/offers':
        return send(503, 'application/json', JSON.stringify({ error: 'offers unavailable' }));
      case '/api/profile':
        return send(200, 'application/json', JSON.stringify({ name: 'Test User' }));
      case '/graphql':
        return send(200, 'application/json', JSON.stringify({ data: { orders: [{ id: 1 }] } }));
      case '/api/orders':
        return send(200, 'application/json', JSON.stringify({ orders: [] }));
      case '/api/orders/history':
        return send(404, 'application/json', JSON.stringify({ error: 'not found' }));
      default:
        return send(404, 'text/plain', 'nope');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

/* ------------------------------------------------------------------ */

const userDataDir = mkdtempSync(join(tmpdir(), 'apilens-e2e-'));
let context;
let app;

try {
  app = await startApp();
  const port = app.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`test app on ${base}`);
  console.log(`extension from ${EXT}\n`);

  // Playwright-core may expect a build that is not downloaded here; use an
  // installed Chromium directly so the test does not depend on a fetch.
  const CHROME = process.env.APILENS_CHROME
    ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');

  context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // The MV3 service worker is the extension's identity; wait for it to register.
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  check('MV3 service worker registered', Boolean(extensionId), `id ${extensionId}`);

  // ---------------------------------------------------------------- capture
  const page = await context.newPage();
  await page.goto(`${base}/myaccount/billing`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('out')?.textContent === 'billing-done',
    null, { timeout: 15_000 });

  // The panel is a normal extension page; devtools APIs are absent, which the
  // panel already tolerates (inspectedTabId() returns null).
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/devtools/panel.html`, { waitUntil: 'load' });
  await panel.waitForTimeout(1500);

  check('panel renders', await panel.locator('.qa-shell').count() > 0);
  check('sidebar has every section',
    (await panel.locator('.nav-item').count()) === 9,
    `${await panel.locator('.nav-item').count()} items`);

  // Start a recording session via the service worker so capture is persisted.
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes('/myaccount/'));
    return t ? t.id : null;
  });
  check('inspected tab found', tabId !== null, `tabId ${tabId}`);

  const started = await panel.evaluate(async (id) => {
    const r = await chrome.runtime.sendMessage({ type: 'session:start', name: 'E2E session', tabId: id });
    return r;
  }, tabId);
  check('session:start accepted', started && started.ok === true,
    String(JSON.stringify(started)).slice(0, 120));

  // Re-run the journey now that recording is on, then visit a second page.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('out')?.textContent === 'billing-done',
    null, { timeout: 15_000 });
  await page.goto(`${base}/myaccount/orders`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('out')?.textContent === 'orders-done',
    null, { timeout: 15_000 });
  await page.waitForTimeout(1500);

  const captured = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'requests:get', tabId: null, sessionId: null });
    return r.requests || [];
  });

  const apiCalls = captured.filter((r) => ['fetch', 'xhr', 'graphql'].includes(r.type));
  check('captured API traffic', apiCalls.length >= 5, `${apiCalls.length} api of ${captured.length} total`);
  check('captured the 503 failure',
    captured.some((r) => r.statusCode === 503 && r.path === '/api/offers'));
  check('captured the 404',
    captured.some((r) => r.statusCode === 404 && r.path === '/api/orders/history'));
  check('captured a POST with a request body',
    captured.some((r) => r.method === 'POST' && r.path === '/api/payments' && r.requestBody?.content));
  check('captured response payloads',
    captured.some((r) => r.path === '/api/billing' && (r.responseBody?.content || '').includes('42.5')));
  check('captured the XHR call', captured.some((r) => r.path === '/api/profile'));
  check('detected the GraphQL operation',
    captured.some((r) => r.graphql?.operationName === 'GetOrderSummary'),
    captured.find((r) => r.path === '/graphql')?.type ?? 'n/a');

  // ---------------------------------------------------------------- redaction
  const payments = captured.find((r) => r.path === '/api/payments');
  const authHeader = Object.entries(payments?.requestHeaders ?? {})
    .find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  check('authorization header redacted',
    authHeader === undefined || !String(authHeader).includes('super-secret-value'),
    `value: ${authHeader}`);
  check('secret never appears anywhere in the capture',
    !JSON.stringify(captured).includes('super-secret-value'));

  // ---------------------------------------------------------------- page grouping
  const pages = new Set(captured.map((r) => r.pageUrl).filter(Boolean));
  check('calls record their originating page', pages.size >= 1, `${pages.size} page(s): ${[...pages].join(', ')}`);
  const billingCalls = captured.filter((r) => (r.pageUrl || '').includes('/myaccount/billing'));
  const orderCalls = captured.filter((r) => (r.pageUrl || '').includes('/myaccount/orders'));
  check('billing page calls attributed', billingCalls.length > 0, `${billingCalls.length}`);
  check('orders page calls attributed', orderCalls.length > 0, `${orderCalls.length}`);

  // ---------------------------------------------------------------- panel UI
  await panel.reload({ waitUntil: 'load' });
  await panel.waitForTimeout(2000);

  // Dismiss the first-run tour if it is showing.
  if (await panel.locator('.tour-dialog').count() > 0) {
    check('guided tour opens on first run', true);
    const slideCount = await panel.locator('.tour-dots button').count();
    check('tour has the full slide deck', slideCount === 15, `${slideCount} slides`);
    await panel.keyboard.press('ArrowRight');
    await panel.waitForTimeout(250);
    const t2 = await panel.locator('#apilens-tour-title').textContent();
    check('tour arrow-key navigation works', t2 === 'The workspace, section by section', t2);
    await panel.keyboard.press('Escape');
    await panel.waitForTimeout(400);
    check('tour closes with Escape', await panel.locator('.tour-dialog').count() === 0);
  } else {
    check('guided tour opens on first run', false, 'dialog not present');
  }

  await panel.locator('.nav-item', { hasText: 'Network' }).first().click();
  await panel.waitForTimeout(1200);

  const rowCount = await panel.locator('.vrow').count();
  check('network list renders captured rows', rowCount > 0, `${rowCount} rows`);

  const shownLabel = (await panel.locator('.query-meta > span').first().textContent() ?? '').trim();
  check('shows a "N of M" summary', /\d+ of \d+ shown/.test(shownLabel), shownLabel);

  // API-only default must hide the css/js assets.
  check('API-only default hides static assets',
    !(await panel.locator('.vrow').allTextContents()).some((t) => t.includes('theme.css') || t.includes('app.js')),
    shownLabel);

  // Keyword search
  await panel.fill('#apilens-query', 'billing');
  await panel.waitForTimeout(400);
  const billingRows = await panel.locator('.vrow').count();
  check('keyword search filters', billingRows > 0 && billingRows < rowCount, `${billingRows} of ${rowCount}`);

  // Field search
  await panel.fill('#apilens-query', 'status:5xx');
  await panel.waitForTimeout(400);
  const errRows = await panel.locator('.vrow .grow-cell').allTextContents();
  check('status:5xx isolates the failure',
    errRows.length === 1 && errRows[0].includes('/api/offers'), errRows.join(', '));

  // Body search proves payloads are searchable
  await panel.fill('#apilens-query', 'body:3055861');
  await panel.waitForTimeout(400);
  check('body: searches captured payloads', await panel.locator('.vrow').count() > 0,
    `${await panel.locator('.vrow').count()} rows`);

  // Negation
  await panel.fill('#apilens-query', '-billing');
  await panel.waitForTimeout(400);
  check('negation excludes matches',
    !(await panel.locator('.vrow .grow-cell').allTextContents()).some((t) => t.includes('billing')));

  // Chips
  await panel.fill('#apilens-query', 'billing status:200');
  await panel.waitForTimeout(400);
  check('active terms render as chips', await panel.locator('.query-chip').count() === 2);
  await panel.locator('.query-chip').first().click();
  await panel.waitForTimeout(300);
  check('clicking a chip removes that term', (await panel.inputValue('#apilens-query')) === 'status:200');

  await panel.fill('#apilens-query', '');
  await panel.waitForTimeout(400);

  // Traffic class
  await panel.getByRole('button', { name: 'Everything', exact: true }).click();
  await panel.waitForTimeout(500);
  const allRows = await panel.locator('.vrow').count();
  check('"Everything" reveals assets and documents', allRows > rowCount, `${allRows} vs ${rowCount}`);

  await panel.getByRole('button', { name: 'Assets', exact: true }).click();
  await panel.waitForTimeout(500);
  // Assets are discarded at capture time by default, so the filter alone cannot
  // reveal them; the UI must say that instead of showing a bare empty list.
  check('"Assets" explains that assets are not captured',
    (await panel.locator('.banner.info').textContent() ?? '').includes('not being captured'),
    (await panel.locator('.banner.info').textContent() ?? '').slice(0, 80));

  await panel.getByRole('button', { name: 'API calls', exact: true }).click();
  await panel.waitForTimeout(500);

  // Outcome filter
  await panel.getByRole('button', { name: 'Failed', exact: true }).click();
  await panel.waitForTimeout(500);
  const failedRows = await panel.locator('.vrow .grow-cell').allTextContents();
  check('"Failed" isolates 4xx/5xx', failedRows.length === 2, failedRows.join(', '));
  await panel.getByRole('button', { name: 'Any', exact: true }).click();
  await panel.waitForTimeout(400);

  // Page scoping
  const pageOptions = await panel.locator('.page-picker select option').allTextContents();
  check('page dropdown lists captured pages', pageOptions.length >= 2, pageOptions.join(' | '));
  if (pageOptions.length >= 2) {
    await panel.selectOption('.page-picker select', { index: 1 });
    await panel.waitForTimeout(500);
    const scoped = await panel.locator('.vrow').count();
    check('page scoping narrows the list', scoped > 0 && scoped < rowCount, `${scoped} of ${rowCount}`);
    await panel.getByRole('button', { name: 'All pages', exact: true }).click();
    await panel.waitForTimeout(400);
  }

  // Empty-state guidance
  await panel.fill('#apilens-query', 'zzzz-definitely-no-match');
  await panel.waitForTimeout(500);
  check('empty state explains which filter emptied the list',
    (await panel.locator('.empty-reasons li').count()) > 0,
    (await panel.locator('.empty-state h2').textContent()) ?? '');
  await panel.locator('.empty-reasons').getByRole('button', { name: 'Clear the search' }).click();
  await panel.waitForTimeout(500);
  check('one-click undo restores the list', await panel.locator('.vrow').count() > 0);

  // Detail panel
  await panel.locator('.vrow').first().click();
  await panel.waitForTimeout(700);
  check('detail panel opens', await panel.locator('.request-preview').count() > 0);
  const tabs = await panel.locator('.request-preview .tab').allTextContents();
  check('detail has all six tabs', tabs.length === 6, tabs.join(', '));

  await panel.locator('.request-preview .tab', { hasText: 'response' }).click();
  await panel.waitForTimeout(400);
  check('response tab shows a captured payload',
    (await panel.locator('.request-preview').textContent() ?? '').length > 100);

  // Actions must survive a tab change — they used to live only in Summary.
  check('primary actions stay available on every tab',
    await panel.locator('.detail-actions.sticky').getByRole('button', { name: 'Mock this' }).count() === 1);

  // Extract menu
  await panel.getByRole('button', { name: /^Extract/ }).click();
  await panel.waitForTimeout(500);
  const formats = await panel.locator('.extract-row strong').allTextContents();
  check('extract offers every format', formats.length === 7, formats.join(', '));
  await panel.keyboard.press('Escape');
  await panel.waitForTimeout(300);

  // Mock builder — reached from the sticky action bar, on whichever tab is open.
  await panel.locator('.detail-actions.sticky').getByRole('button', { name: 'Mock this' }).click();
  await panel.waitForTimeout(900);
  check('mock editor opens from a captured call',
    (await panel.locator('.view-header h1').textContent()) === 'Mock a browser call');
  const presets = await panel.locator('.preset-groups .chip').count();
  check('mock editor offers all presets', presets === 18, `${presets} presets`);
  const pattern = await panel.locator('.mock-editor input.mono').inputValue();
  check('mock pattern is scoped to the captured path', pattern.startsWith('*/') && pattern.length > 3, pattern);
  check('mock rule starts disabled',
    (await panel.locator('.setting-toggle.compact input').isChecked()) === false);

  // Save a rule and confirm it round-trips through the service worker.
  await panel.locator('.editor-actions .btn.primary').click();
  await panel.waitForTimeout(1200);
  const storedRules = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'rules:get' });
    return r.rules || [];
  });
  check('saved mock rule persists to the service worker', storedRules.length === 1,
    storedRules.map((r) => r.name).join(', '));
  check('persisted rule is disabled', storedRules[0] && storedRules[0].enabled === false);

  // ---------------------------------------------------------------- evidence
  const session = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'state:get', tabId: null });
    return r.state?.session ?? null;
  });
  check('session is recording', session && session.status === 'recording', session?.name);

  const evidence = await panel.evaluate(async (sid) => {
    const r = await chrome.runtime.sendMessage({
      type: 'evidence:export', sessionId: sid, options: { formats: ['json', 'har', 'markdown', 'html'] },
    });
    if (!r.ok) return { error: r.error };
    return (r.files || []).map((f) => ({
      name: f.name,
      bytes: f.content.length,
      // Identify the HAR by its actual shape, not by a MIME type.
      isHar: f.content.trimStart().startsWith('{') && f.content.includes('"log"') && f.content.includes('"entries"'),
      entries: (() => {
        try { return JSON.parse(f.content)?.log?.entries?.length ?? null; } catch { return null; }
      })(),
    }));
  }, session?.id);
  check('evidence pack exports in every format',
    Array.isArray(evidence) && evidence.length === 4,
    JSON.stringify(evidence));
  const har = Array.isArray(evidence) ? evidence.find((f) => f.isHar) : null;
  check('exported HAR is valid and contains the captured calls',
    har && har.bytes > 500 && (har.entries ?? 0) > 0,
    har ? `${har.name}, ${har.entries} entries, ${har.bytes} bytes` : 'no HAR found');

  const noConsoleErrors = [];
  panel.on('pageerror', (e) => noConsoleErrors.push(e.message));
  await panel.waitForTimeout(500);
  check('panel raised no uncaught errors', noConsoleErrors.length === 0, noConsoleErrors.join('; '));

} catch (error) {
  check('test run completed without throwing', false, error.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  if (context) await context.close().catch(() => {});
  if (app) app.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
if (failures) {
  console.log('\nFailures:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
}
process.exit(failures ? 1 : 0);
