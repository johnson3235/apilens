# Extension end-to-end test

Drives the **built** extension in a real Chromium browser: loads `dist` as an
unpacked MV3 extension, serves a small test application, and exercises the real
DevTools panel — capture, redaction, filtering, page scoping, extraction, the
mock builder and the evidence export.

This verifies the shipped artefact rather than a component harness, so it
catches integration faults the unit tests cannot: service-worker messaging,
manifest/permission problems, content-script injection and panel wiring.

## Running it

It is deliberately **not** part of `pnpm check`, because it needs a browser
binary and takes about a minute. Install `playwright-core` once, then:

```powershell
pnpm --filter @apilens/browser-extension build
cd apps/browser-extension/e2e
npm install playwright-core
node extension.e2e.mjs
```

The script looks for a Playwright Chromium under `%LOCALAPPDATA%\ms-playwright`.
Point it somewhere else with `APILENS_CHROME`:

```powershell
$env:APILENS_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node extension.e2e.mjs
```

It prints one line per check and exits non-zero if any fail.

## What it covers

| Area | Checks |
|---|---|
| Load | MV3 service worker registers; panel renders; all nine sections present |
| Capture | fetch, XHR, GraphQL, POST bodies, response payloads, 4xx/5xx, transport errors |
| Privacy | `authorization` is redacted and the secret appears nowhere in the capture |
| Pages | Calls are attributed to the page that made them, across a navigation |
| Filtering | Keyword, `status:`, `body:`, negation, chips, traffic class, outcome, page scope |
| Empty state | Names the responsible filter and restores with one click |
| Detail | Six tabs; payload rendering; actions reachable from every tab |
| Mocking | Editor opens pre-filled, 18 presets, scoped pattern, starts disabled, persists |
| Evidence | JSON, HAR, Markdown and HTML export; HAR parses and contains the entries |

Browser binaries are not committed, and the test writes only to a temporary
profile directory which it removes afterwards.

## Server API test

`server.e2e.mjs` checks the Server API workspace against the instrumented demo app
(see [docs/SETUP.md](../../../docs/SETUP.md#demo-applications)): incoming routes with their
upstream calls, payload capture and redaction, and a server mock created from a captured
call in the panel, saved, enabled, observed, then removed.

```powershell
$env:APILENS_CONTROL_TOKEN = '<token the demo app was started with>'
$env:APILENS_SHOTS = "$env:TEMPpilens-shots"   # optional: one screenshot per step
node server.e2e.mjs
```

`APILENS_APP` overrides the app URL (default `http://localhost:3000`), and
`APILENS_PLAYWRIGHT` points at a `playwright-core` entry file installed elsewhere.
