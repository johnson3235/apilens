# CLEAR-APP: browser-only ApiLens QA

This runbook remains the zero-app-change **browser-only** path. For the newly added opt-in server tracing package, use [the Next SDK integration guide](../sdks/next/README.md). That separate path requires FE route wrappers, server-only configuration and an authenticated agent. The legacy SDK limitations below refer to `@apilens/node-sdk`, not the new `@apilens/next-sdk`.

## Scope and decision

No SDK install, `.env.example`, custom server, or application instrumentation changes. No `lint:all` / `build:all` requirement. The FE team reports 32 App Router `/api/*` routes, native fetch through `@vfie/core-networking@0.0.594`, no service worker and no capture-blocking CSP. These CLEAR-APP observations were supplied by the FE team, not independently re-tested here.

The current SDK middleware depends on Express `res.on('finish')` and `res.status().send()`, not Web Request/Response. It establishes AsyncLocalStorage context; constructing the SDK alone does not. Outbound interception patches `http.request` and `https.request`, not native fetch. Starting an agent cannot fix these missing adapters.

See `examples/demo-nextjs-app/apilens.config.ts` and `pages/api/products.ts`: the config instantiates the SDK and the API handler uses fetch, without mounting Express middleware. This demo is not evidence of server-to-backend fetch visibility.

`instrumentation.ts` is the future Node boot hook for an appropriate adapter, not a working integration today. CLEAR-APP's `src/middleware.ts` runs on Edge according to the FE team and is not a mount point for this Node SDK. Do not invent a custom Express server. `workspace:*` dependencies cannot be installed directly with yarn from the separate CLEAR-APP repository; a portable distribution is a separate task.

## Branch hygiene (CLEAR-APP only)

Do not commit onto `feat/clear-payg-order-summary`. The FE team reports tracked `.env.development` changes and untracked briefs. Preserve them. If runbook files are needed there, use a separate clean worktree on `chore/adhoc-apilens-qa-setup` from `develop`, after checking existing branch/worktree state. Do not reset, overwrite env files, or copy briefs. No CLEAR-APP checkout is modified by this ApiLens update.

## Build and use the extension

1. In ApiLens, run `pnpm install --frozen-lockfile`, then `pnpm --filter @apilens/browser-extension check`. Build the source checkout; do not assume dist exists.
2. Load `apps/browser-extension/dist` unpacked in Chromium/Brave. After rebuilding, reload both the extension and target page.
3. Start CLEAR-APP with its established local development command and approved configuration; do not add or change env files for ApiLens.
4. Open the popup, start a QA session, reload the page and perform an approved journey.
5. In Requests, select an API to inspect request and response headers. Search by header name; values are selectable for copying. DevTools → ApiLens → Network also shows headers.
6. Confirm a known browser → `/api/*` request appears. Server → backend requests remain invisible. Missing server spans are not an extension capture failure.
7. Stop the session, review and export evidence. Screenshots need manual review for sensitive pixels.

## Agent is optional

`pnpm agent` is NOT required for this path. Keep agent integration off when no server instrumentation is installed. Connection refused on `127.0.0.1:7317` means an optional agent is not running, not that browser capture is broken. The agent is also used by optional proxy/replay/filesystem workflows; none is required for browser capture or popup evidence export.

## Headers and safe testing

The extension applies `redactRequest` before storage/broadcast. Diagnostic headers remain visible; credentials and configured sensitive values remain masked. Capture depends on the channel and browser API; missing headers do not prove a server omitted them. The current SDK's outbound unredacted-header issue applies to a future SDK installation, not this browser-only recommendation. Review and harden that path before deployment.

Do not mock against preprod or a real submit-order journey: a fake successful submit-order can misrepresent whether an order was placed. Test mocks only on dedicated local/test targets approved for this purpose. A green engine status is a technical readiness check, not business authorization to mock.

## Acceptance checklist

- Browser Fetch/XHR requests are captured with the agent disconnected.
- Selecting a request displays captured request/response headers, with secrets masked.
- Local/test mock applies only to its exact intended API; disabling it restores real traffic.
- Evidence retains title, scenarios and captured requests; no secret values are shared.
- App Router server-fetch visibility is explicitly unavailable, not falsely reported as connected.
