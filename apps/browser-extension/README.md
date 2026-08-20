# ApiLens browser extension

ApiLens 0.6.1 has two mock engines. The page engine runs in the page world at `document_start`. On Chromium browsers, a strict CSP or page hardening can prevent that hook from installing, so Brave, Chrome, and Edge automatically fall back to a browser-level network engine that fulfills matching Fetch/XHR requests before they reach the server.

## Build and verify

From the repository root:

```powershell
pnpm --filter @apilens/browser-extension check:all
```

This runs the mock-engine regression suite and produces three verified targets:

- `apps/browser-extension/dist` — Brave, Chrome, and Edge.
- `apps/browser-extension/dist-firefox` — Firefox MV3.
- `apps/browser-extension/dist-safari` — Safari Web Extension source bundle.

## Install or update

After rebuilding, reload the extension and then reload the target webpage. Reloading only the webpage can leave the browser's previous extension service worker active.

### Brave, Chrome, and Edge

1. Open `brave://extensions`, `chrome://extensions`, or `edge://extensions`.
2. Enable **Developer mode**.
3. Remove any duplicate/older unpacked ApiLens copy.
4. Choose **Load unpacked** and select `apps/browser-extension/dist`.
5. Accept the browser's **debugging** permission. It enables the CSP-proof network fallback only for the tab being mocked.
6. After every rebuild, click **Reload** on the ApiLens extension card, then reload the target page.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `apps/browser-extension/dist-firefox/manifest.json`.
4. Reload the target page and reopen DevTools.

Temporary Firefox add-ons are removed when Firefox exits. A permanent public Firefox build must be packaged and signed through Mozilla Add-ons.

### Safari (macOS / iOS)

Safari requires a Safari Web Extension container; it cannot load the Chromium unpacked directory directly. Copy `apps/browser-extension/dist-safari` to a Mac and run:

```bash
xcrun safari-web-extension-packager /path/to/dist-safari --project-location /path/to/output --app-name ApiLens --swift
```

Open the generated Xcode project, enable ApiLens in Safari, and grant it **All Websites** access. Safari 18+ is required for the page-world mock engine. Apple requires the containing app/Xcode package for testing and distribution.

## Confirm that mocking is real

1. Open ApiLens and create an enabled rule whose URL/path and method match the application request.
2. The header bar must show either **Page mock engine active** or **Network mock engine active**. Use **Repair now** if it does not.
3. Click **Run test**. Both Fetch and XHR must return 503.
4. Trigger the real application action.
5. In the ApiLens DevTools panel, the request is labeled **MOCKED BY APILENS**. Synthetic responses also contain:

```text
x-apilens-mocked: true
x-apilens-mocked-from: ApiLens
x-apilens-rule: <rule name>
x-apilens-transport: page-fetch | page-xhr | chromium-network
```

When the page engine is active, a matched request is stopped before the network, so it may have no native Network row; the ApiLens panel is the authoritative mock log. When the Chromium network engine is active, the browser Network panel receives the forced response (for example 503) and shows the `x-apilens-*` headers. If a request still returns 200, it is unmatched, a duplicate call, or a request made outside the page.

## Browser and server boundaries

- Brave, Chrome, and Edge use the network fallback when a strict CSP blocks page hooks. It covers Fetch/XHR direct responses and network failures while DevTools is open or closed.
- Firefox and Safari use the page engine. Grant the extension website access and reload the target tab after installation.
- Restricted child frames are repaired best-effort; failure in one child frame no longer disables the top page.
- Service-worker, browser-internal, extension-origin, navigation, and server-to-server/SSR requests cannot be rewritten by a page WebExtension hook.
- Server-side calls appear in ApiLens only when the controlled backend uses the ApiLens SDK/trace gateway. Enable **Node SDK server integration** only for those environments. Server-side mocking must be enforced by that server SDK; a browser extension cannot force an already-executed SSR call to return a different status.

The engine health check validates the exact rule revision, not only the number of enabled rules, so replacing one rule with another can no longer produce a false “synced” state.
