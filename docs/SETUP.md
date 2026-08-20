# Setup Guide

## Prerequisites
- Node.js 20+
- pnpm 9+
- Docker
- Chrome Browser

## Quick Start with Docker Compose
To start the entire environment with a single command:
```bash
cd infrastructure/docker
docker-compose up -d
```

## Manual Development Setup
1. **Install Dependencies:**
   ```bash
   pnpm install
   ```
2. **Database Setup:**
   Make sure Postgres and Redis are running locally, then push the schema:
   ```bash
   cd apps/control-plane-api
   pnpm prisma db push
   ```
3. **Start Services:**
   Run the dev command from the root:
   ```bash
   pnpm dev
   ```

## Loading the Extension in Edge or Chrome
1. Open `edge://extensions/` in Microsoft Edge (or `chrome://extensions/` in Chrome).
2. Enable "Developer mode" (toggle in the top right).
3. Click "Load unpacked".
4. Select the `apps/browser-extension/dist` folder in the ApiLens project directory.
5. After rebuilding, use the **Reload** button on the extension card.

## Loading and testing in Brave

Brave uses Chromium extensions and can load the same Manifest V3 `dist` folder.

For a safe isolated test profile on Windows, run from the repository root:

```powershell
pnpm brave
```

This rebuilds ApiLens, finds Brave automatically, and opens Brave with only the local ApiLens extension enabled. The isolated profile is stored in `.brave-extension-profile` and does not change the normal Brave profile.

To install it in your normal Brave profile instead:

1. Open `brave://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `apps/browser-extension/dist`.
4. For future code changes, run `pnpm --filter @apilens/browser-extension build` and click **Reload** on the ApiLens extension card.

### Testing response mocks

Create and enable the rule from the ApiLens toolbar popup. ApiLens now reports a rule as active only after the top page frame acknowledges the current rule set and confirms that both the `fetch` and `XMLHttpRequest` hooks are installed. The health banner auto-repairs missing hooks; **Repair now** is also available for a manual retry. Reload the target page once after installing or updating the unpacked extension so old page-world code is removed.

Use **Run test** in the health banner to execute an ephemeral in-page diagnostic. It must force both a Fetch request and an XHR request to synthetic `503` responses without contacting the `.invalid` test host. Saving a rule also runs this diagnostic automatically; ApiLens no longer reports the rule as active when the page hooks fail the test.

Browser mocks intercept page-level `fetch` and `XMLHttpRequest` calls before they reach the network, so they continue working while F12 DevTools is open. Because a matched request is synthetic, the built-in Network panel might not contain a normal network row; use the ApiLens request list to inspect its delivered status, body, duration, error, and applied scenario.

Supported browser cases include custom status/body/headers, empty or invalid JSON, rate limiting, delay/slow response, timeout, connection/DNS failure, and JSON field deletion/null/type changes. Requests issued by service workers or browser internals are outside page-level interception. Server-to-server requests require the ApiLens Node SDK middleware described below.

ApiLens also records beacon outcomes and can simulate WebSocket disconnects and SSE interruptions. In the ApiLens DevTools panel, use the **Mocked by ApiLens** filter and result badge to distinguish synthetic results. Synthetic responses include `X-ApiLens-Mocked`, `X-ApiLens-Rule`, `X-ApiLens-Transport`, and—when a real response was transformed—`X-ApiLens-Original-Status` metadata.

Chromium does not expose an extension API for adding or renaming rows in the browser's built-in Network panel. ApiLens therefore provides its own integrated Network view. A request stopped before transport has no native Network row; a response transformed after transport shows its original server response in the native panel and the delivered mock in ApiLens.

Server-side calls are reported through the Node SDK and require the control-plane API, Redis, and realtime gateway to be running. The extension connects to `ws://localhost:3002` by default. In **QA Mocks**, explicitly enable **Node SDK server integration** to add the `X-QA-Session-ID` and `X-ApiLens-Rules` headers. It is off by default to avoid changing CORS/preflight behavior on ordinary sites. Each controlled service must install `apiLens.expressMiddleware()` before its application routes.

## Running the Demo Scenario
1. **Start all services** (via Docker Compose or manually).
2. **Load the extension** in Chrome as described above.
3. Open `http://localhost:3000` in Chrome.
4. Open Chrome DevTools and navigate to the **ApiLens** panel.
5. Watch the browser requests appear as you interact with the page.
6. Navigate to `/checkout` to see server-side rendering (SSR) calls.
7. **Create a scenario:** In the extension, mock the `POST /api/payments` endpoint to return a `503 Service Unavailable`.
8. Click "Pay" on the checkout page and observe the failure gracefully handled.
9. View the unified timeline showing both the client and server traces.
10. Export the scenario as Playwright code for automated tests.

## Architecture Overview
ApiLens consists of a browser extension, a control plane API, a real-time gateway, and SDKs (Node.js/Python) that work together to trace and mock full-stack requests in a unified manner.

## Troubleshooting
- **Extension not showing requests?** Make sure DevTools is open and the ApiLens panel is active.
- **Trace not appearing?** Verify `APILENS_REPORTER_URL` is configured properly.
- **Popup says the mock engine is inactive?** Keep the target HTTP(S) tab selected and click **Repair now**. If the extension was just updated, reload the target page once. Browser-internal pages such as `brave://`, `edge://`, and extension stores cannot be injected.
- **The built-in Network panel still shows a server 200?** First check the ApiLens panel for a separate **Mocked by ApiLens** result. A pre-network mock has no native Network row. If the page still consumes the 200, confirm the popup health banner is green and create the rule from the exact captured request so its URL condition matches.
