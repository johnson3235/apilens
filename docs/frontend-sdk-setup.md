# CLEAR-APP frontend handoff: ApiLens server tracing

## Requested change

Integrate **`@apilens/next-sdk@0.5.0`** in CLEAR-APP. Do **not** install the legacy `@apilens/node-sdk`: it is an Express/http adapter, not the App Router adapter.

The SDK records every incoming Node-runtime request (pages, Server Components including `generateMetadata`, server actions, route handlers) and the backend calls made while handling it, whether through global `fetch` (so `@vfie/core-networking`) or a Node `http`/`https` client such as axios, with no changes to page, layout or route files. Its `/edge` entry adds the calls made by Edge middleware. For each call it records service, method, URL origin/path, status, timing, sanitized headers, errors, parent/child trace IDs and **bounded, redacted request and response payloads**. It can apply **server-side mock rules** to upstream calls, and serves an authenticated **in-app control plane** so a tester can inspect a remote dev deployment that a loopback agent cannot reach.

It does not capture DB queries, background jobs outside a request, Edge *route handlers*, gRPC/raw TCP clients or downstream service internals. Next fetch-cache hits never reach the SDK (no backend call happened); calls with `cache: 'no-store'` and every cache miss are captured.

Repository: https://github.com/johnson3235/apilens

Detailed API and integration examples: [Next SDK README](../sdks/next/README.md). The 0.5.0 section there explains the capture diagnosis (why a connected server shows no calls); the 0.4.0 section maps each finding of the 0.3.0 CLEAR-APP review to its fix.

## What CLEAR-APP changes

| File | Change |
| --- | --- |
| `package.json`, `yarn.lock` (and `vendor/*.tgz` if vendored) | Add `@apilens/next-sdk@0.5.0` |
| `src/lib/apilens.server.ts` | New singleton, about 25 lines |
| `src/instrumentation.ts` | Two lines inside the existing `nodejs` branch |
| `src/middleware.ts` | Wrap the exported middleware with `withApiLens` (one import, one call) |

No control route file: the SDK serves `/api/__apilens` from its request hook. `next.config.mjs` already sets `experimental.instrumentationHook: true`, which Next 14.2 needs.

## 1. Preserve the existing CLEAR-APP work

- The FE team reports a dirty `feat/clear-payg-order-summary` checkout, tracked `.env.*` changes and untracked briefs. Inspect the current state; do not assume it has remained unchanged.
- Work in a separate clean worktree on `chore/adhoc-apilens-qa-setup` based on `develop`. Check whether that branch/worktree already exists before creating it.
- Do not reset/stash/overwrite existing work, edit tracked env files, create `.env.example`, or commit to the feature branch.

## 2. Get the package

Preferred: the `next-sdk-v0.5.0` GitHub Release built by `.github/workflows/next-sdk-release.yml` (tarball plus SHA-256), mirrored into the team's approved artifact registry.

Or build it from an ApiLens checkout:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @apilens/next-sdk build
pnpm --filter @apilens/next-sdk test
cd sdks/next
pnpm pack
```

Output: `sdks/next/apilens-next-sdk-0.5.0.tgz`. It has no runtime or `workspace:*` dependencies and is not published to npm. If checked-in vendor artifacts are allowed, put it at `CLEAR-APP/vendor/apilens-next-sdk-0.5.0.tgz` and use the project's Yarn version:

```powershell
yarn add file:./vendor/apilens-next-sdk-0.5.0.tgz
```

Keep the artifact available to CI; do not commit a lockfile pointing at a personal absolute path. Do not publish it anywhere without approval.

## 3. Add the integration

Follow the code in the [SDK README](../sdks/next/README.md):

1. Create one HMR-safe `ApiLensNextSDK` singleton in `src/lib/apilens.server.ts`, protected by `server-only`, with `enabled: process.env.APILENS_ENABLED === 'true'` and the actual approved origin in `allowedAppOrigins`.
   - **Remote dev deployment:** `reportToAgent: false`, `captureWithoutSession: true`, `control: { enabled: true, token: process.env.APILENS_CONTROL_TOKEN ?? '', maxBufferBytes: 32 * 1024 * 1024 }`.
   - **Local run:** the server-only `APILENS_AGENT_TOKEN` instead (or both).
   - `autoInstrument.ignorePaths: ['/api/check-session']`, so the 60-second session poll does not flood the buffer.
   - Pass the token as it is. A missing or short token no longer stops the app: the control plane stays off and `apiLens.diagnostics.configIssues` says why. No length check is needed in the singleton.
2. Merge Node-only `apiLens.install()` into the existing `instrumentation.ts`; preserve `patchConsole()` and any other instrumentation. That is all the Node wiring: every page, Server Component, server action and route handler is captured with its backend calls. **Do not edit page, layout or route files.**
3. Wrap the existing Edge middleware with `withApiLens` from `@apilens/next-sdk/edge` (README step 3d), using the same `APILENS_ENABLED` and `APILENS_CONTROL_TOKEN`. Keep its matcher and logic unchanged. Behind a load balancer, set `ingestUrl` to the pod's own address so delivery reaches the same process the extension reads.
4. Datadog (`--require @vfie/wef-tracing`) needs nothing: the tracer agent on `:8126` and the `DD_AGENT_HOST` / `DD_TRACE_AGENT_URL` hosts are ignored automatically, and background calls that start after a response finished are not attributed to it.
5. `wrapRoute`/`traceRender` remain available but are optional (for example route-level mocks with `allowRouteMocks`). A control route file is only needed with `control.relay` on a serverless host; CLEAR's single container does not need it.

Do not add a custom Express server or import the SDK into React Client Components.

## 4. Start the server-tracing path

### Remote dev deployment (control plane)

Deploy with `APILENS_ENABLED=true` and a strong `APILENS_CONTROL_TOKEN` (24+ characters, different from any agent token) through the approved configuration mechanism. Optionally set `APILENS_CONTROL_EXPIRES_AT` and pass it as `control.expiresAt`, so the token stops working when the QA exercise ends. No local agent is involved.

Build/load the extension (1.4.0) with `pnpm --filter @apilens/browser-extension check`, then load `apps/browser-extension/dist` unpacked. In **Settings → Instrumented server**, paste the app origin and the control token and press **Test connection**: it reports the SDK version and any configuration issues. Save.

Each tester then presses **Record session** in the CLEAR-APP tab and reloads. While recording, that tab's own requests (page loads, RSC, server actions, fetch) carry `x-qa-session-id`, so **Server calls → My session** shows only that tester's calls on the shared server. **Everyone** shows all traffic. Calls appear with Sent and Received tabs, and **Simulate a problem** pushes a rule back to the server.

### Local machine (loopback agent)

From ApiLens:

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

Use the printed agent token in CLEAR-APP's approved local process configuration as `APILENS_AGENT_TOKEN`; enable tracing explicitly with `APILENS_ENABLED=true`. Keep these settings out of tracked env files and never use `NEXT_PUBLIC_*` for the token. Restart CLEAR-APP after configuration changes.

In extension Settings: save the same token and connect the agent, then enable **Inject trace headers**. Start a QA session in the CLEAR-APP tab, reload and perform a safe journey. Open **Traces** and expand the calls.

The agent is required only for the loopback path; the control plane replaces it for remote servers. The reporter uses authenticated `POST /v1/spans`. `/health` exposes only health information.

## 5. Acceptance and evidence

| Check | Required evidence |
| --- | --- |
| SDK off | Requests and application behavior unchanged; nothing patched; no captures |
| Missing/short token | App boots and serves normally; `/api/__apilens/health` returns 404; `configIssues` names `control.token` |
| Page + backend calls | A page call with its JCS/CMS calls nested underneath, matching trace IDs |
| Middleware | The session / journey / billing-account calls appear under a `clear-app-middleware` call |
| Payloads | Request and response bodies visible in **Server calls**, with truncation/redaction flags; `msisdn` and e-mail redacted |
| Headers | Diagnostic headers visible; authorization/cookie/token-like values masked |
| Datadog | No `:8126` calls in the capture; `diagnostics.ignoredOutgoingCalls` increases |
| Control plane auth | Wrong token returns 401; disabled or expired control plane returns 404 |
| Server mock | Enabled rule changes the upstream result; the call is reported as mocked and `appliedCount` increases |
| Two testers | Each tester's **My session** shows only their own calls |
| Abort/error | Original application error preserved; failed call recorded |
| Memory | `/health` `bufferedBytes` stays under `maxBufferBytes` during a busy session |

Use scoped tests/typecheck/lint for changed files and the project's approved validation commands; do not run `lint:all` / `build:all` by default. Do not claim CLEAR-APP end-to-end success without observing its real page, middleware and backend calls. ApiLens's own tests (SDK unit tests, the demo app's `check:live`, and the extension's Chromium e2e) are not a substitute for target-project validation.

## Deployment and safety limits

- The loopback-agent path targets a long-lived local Node process. Preprod server `127.0.0.1` is not the tester's laptop; for a remote deployment use the control plane instead, and never expose the agent publicly.
- The control plane hands redacted captured traffic to anyone holding its token. Use dev only, never preprod or prod. Use a strong token, rotate it after each QA exercise (or set `control.expiresAt`), and remove the configuration when the exercise ends. A disabled control plane returns 404 and does not reveal that ApiLens is installed.
- Incoming QA headers are correlation metadata, not access control. Enable only in an approved, access-controlled test environment.
- Server mocks run inside the application process. Never point one at an endpoint with real financial or order side effects, and never fake a successful `submit-order` against preprod. Rules start disabled, live only in process memory, and disappear on restart.
- Captured payloads are redacted on the write path (structural JSON key redaction including `msisdn`, phone, e-mail and date of birth; JWT, bearer, card-number, IBAN and e-mail value patterns) and bounded by `captureBodies.maxBytes` and `control.maxBufferBytes`. This is a strong default, not a universal PII guarantee: add CLEAR-specific keys to `redactKeys` and review payloads before sharing evidence.
- Telemetry is best-effort with bounded queues, timeouts and drop counters. Inspect `apiLens.diagnostics`; use `await apiLens.flush()` in controlled verification. `shutdown()` restores the patched Node functions.

Rollback: set `APILENS_ENABLED=false` (nothing is patched) and restart CLEAR-APP; stop the QA session and clear the saved control token in extension Settings. No secret should need removing from Git because none should have been committed.

For implementation by Claude, use [the ready-to-copy prompt](claude-clear-app-sdk-prompt.md).
