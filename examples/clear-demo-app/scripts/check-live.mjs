// Pre-meeting check against a running CLEAR demo (local or Vercel), no browser needed.
//
//   node scripts/check-live.mjs https://your-app.vercel.app <APILENS_CONTROL_TOKEN>
//   (or set CLEAR_DEMO_URL and APILENS_CONTROL_TOKEN)
//
// Loads the server-rendered billing page, confirms ApiLens captured it as a
// page call with the 3 backend calls behind it, proves a one-shot server mock
// breaks only the Next bill section once, then removes the mock. Also checks
// the dashboard's browser-side endpoints. Leaves the mock rules as it found them.

const base = (process.argv[2] ?? process.env.CLEAR_DEMO_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const token = process.argv[3] ?? process.env.APILENS_CONTROL_TOKEN ?? '';
const BILLING = '/myaccount/billing?contactId=3055861';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function control(path, init = {}) {
  const response = await fetch(`${base}/api/__apilens${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** The Next bill card's text from the rendered HTML. */
function nextBillCard(html) {
  const start = html.indexOf('data-testid="next-bill"');
  return start < 0 ? '' : html.slice(start, html.indexOf('</section>', start)).replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'");
}

async function billingPage() {
  const response = await fetch(`${base}${BILLING}`, { cache: 'no-store' });
  return { status: response.status, html: await response.text() };
}

/** Captures can arrive a moment after the page (relay on Vercel), so poll briefly. */
async function callsWhere(predicate, attempts = 10) {
  let calls = [];
  for (let i = 0; i < attempts; i += 1) {
    calls = (await control('/calls?since=0&limit=500')).body?.calls ?? [];
    if (predicate(calls)) break;
    await sleep(500);
  }
  return calls;
}

if (token.length < 24) {
  console.error('Pass the APILENS_CONTROL_TOKEN (24+ characters) as the second argument.');
  process.exit(2);
}

console.log(`Checking ${base}\n`);
try {
  const health = await control('/health');
  if (!check('ApiLens control endpoint answers', health.status === 200 && health.body?.ok === true,
    health.status === 200 ? `${health.body.serviceName} · SDK ${health.body.sdkVersion}` : `HTTP ${health.status} ${String(JSON.stringify(health.body)).slice(0, 120)}`)) {
    throw new Error('Check APILENS_ENABLED=true and the token on the server, then redeploy.');
  }

  const before = (await control('/rules')).body?.rules ?? [];
  await control('/calls', { method: 'DELETE' });

  // Server-rendered billing page: all data arrives in the HTML.
  const page = await billingPage();
  check('billing page renders €80.00, €12.99 and the bill history',
    page.status === 200 && page.html.includes('€80.00') && page.html.includes('€12.99') && page.html.includes('INV-2026-09'),
    `HTTP ${page.status}`);

  const isPage = (call) => call.kind === 'server' && call.path === '/myaccount/billing';
  const calls = await callsWhere((list) => list.some(isPage) && list.filter((call) => call.path.startsWith('/api/services/')).length >= 3);
  const pageCall = calls.find(isPage);
  const backendCalls = calls.filter((call) => call.kind === 'client' && call.path.startsWith('/api/services/'));
  check('page render captured as a page call', Boolean(pageCall), pageCall ? `${pageCall.method} ${pageCall.path}` : `${calls.length} calls seen`);
  check('3 backend calls captured', backendCalls.length === 3, backendCalls.map((call) => call.path.split('/')[3]).join(', '));
  check('backend calls are linked to the page call',
    backendCalls.length === 3 && backendCalls.every((call) => call.parentSpanId === pageCall?.spanId));
  check('backend answers captured', backendCalls.some((call) => call.responseBody?.content?.includes('12.99')));

  // One-shot "Service is down" on the next-bill backend call, as the panel would create it.
  const now = Date.now();
  const rule = {
    id: `check-live-${now}`, name: 'check-live: next bill → 503', description: 'Temporary rule from scripts/check-live.mjs',
    enabled: true, priority: 1,
    match: { method: 'GET', urlPattern: '*/api/services/billing/*', matchType: 'glob', kind: 'client' },
    action: { type: 'status-code', statusCode: 503, body: JSON.stringify({ error: 'Service unavailable', simulated: true }) },
    applyMode: 'once', appliedCount: 0, createdAt: now, updatedAt: now,
  };
  const saved = await control('/rules', { method: 'PUT', body: JSON.stringify({ rules: [...before, rule] }) });
  check('one-shot mock saved', saved.status === 200, `HTTP ${saved.status}`);

  const mocked = await billingPage();
  const card = nextBillCard(mocked.html);
  check('Next bill shows the friendly error while mocked', card.includes('load this right now') && card.includes('503'), card.replace(/\s+/g, ' ').trim().slice(0, 90));
  check('the other sections still load', mocked.html.includes('€80.00') && mocked.html.includes('INV-2026-09'));
  await sleep(800); // let the rule use reach the control endpoint (relay)
  const again = await billingPage();
  check('next page load is back to normal (one-shot)', nextBillCard(again.html).includes('€12.99'));

  const restored = await control('/rules', { method: 'PUT', body: JSON.stringify({ rules: before }) });
  check('temporary mock removed', restored.status === 200);

  // Dashboard: loads in the browser through the BFF endpoints.
  const [due, next] = await Promise.all(['amount-due', 'next-bill'].map((path) =>
    fetch(`${base}/api/billing/${path}?contactId=3055861`, { cache: 'no-store' }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }))));
  check('dashboard endpoints answer €80.00 and €12.99', due.status === 200 && due.body?.amountDue === 80 && next.status === 200 && next.body?.amount === 12.99);
} catch (error) {
  failures += 1;
  console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\n${failures === 0 ? 'Ready for the demo.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
