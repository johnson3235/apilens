# CLEAR-APP frontend handoff: ApiLens server tracing

## Requested change

Integrate **`@apilens/next-sdk@0.2.0`** in the Node runtime of CLEAR-APP. Do **not** install the legacy `@apilens/node-sdk`: it is an Express/http adapter, not the App Router adapter.

The new SDK records wrapped App Router HTTP handlers and native/global `fetch` calls made inside their QA context. It records service, method, URL origin/path, status, timing, sanitized headers, errors, parent/child trace IDs and — new in 0.2.0 — **bounded, redacted request and response payloads**. It can also apply **server-side mock rules** to upstream calls, and expose an authenticated **in-app control plane** so a tester can inspect a remote dev deployment that a loopback agent cannot reach.

It does not capture DB queries, Server Actions/SSR, background jobs, direct `http.request`, Edge execution or downstream service internals automatically. Cached fetch results are not proof of an actual backend network call.

Repository: https://github.com/johnson3235/apilens

Detailed API and integration examples: [Next SDK README](../sdks/next/README.md).

## 1. Preserve the existing CLEAR-APP work

- The FE team reports a dirty `feat/clear-payg-order-summary` checkout, tracked `.env.*` changes and untracked briefs. Inspect the current state; do not assume it has remained unchanged.
- Work in a separate clean worktree on `chore/adhoc-apilens-qa-setup` based on `develop`. Check whether that branch/worktree already exists before creating it.
- Do not reset/stash/overwrite existing work, edit tracked env files, create `.env.example`, or commit to the feature branch.

## 2. Build and install the portable package

From the updated ApiLens source checkout:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @apilens/next-sdk build
pnpm --filter @apilens/next-sdk test
cd sdks/next
pnpm pack
```

Output: `sdks/next/apilens-next-sdk-0.2.0.tgz`. Generated dist/tarballs are not committed; a GitHub source checkout must be built. This package is not published to npm and has no runtime or `workspace:*` dependencies.

Make the artifact available through the team's approved distribution process. If checked-in vendor artifacts are allowed, put it at `CLEAR-APP/vendor/apilens-next-sdk-0.2.0.tgz`, then use the project's Yarn version:

```powershell
yarn add file:./vendor/apilens-next-sdk-0.2.0.tgz
```

Keep the artifact available to CI; do not commit a lockfile pointing at a personal absolute path. If vendor artifacts are prohibited, agree on an approved package/artifact registry instead; do not silently publish it.

## 3. Add server-only integration

Follow the code in the [SDK README](../sdks/next/README.md):

1. Create one HMR-safe `ApiLensNextSDK` singleton in `src/lib/apilens.server.ts`, protected by `server-only`.
2. Use `enabled: process.env.APILENS_ENABLED === 'true'` and the actual approved origin in `allowedAppOrigins`. For a **remote dev deployment** set `reportToAgent: false`, `captureWithoutSession: true` and `control: { enabled: true, token: process.env.APILENS_CONTROL_TOKEN }`. For a **local** run keep the server-only `APILENS_AGENT_TOKEN` instead.
3. Merge Node-only `installFetch()` bootstrapping into the existing `instrumentation.ts`; preserve other instrumentation. Follow the installed Next version's configuration requirements.
4. Wrap each relevant exported GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS handler with `apiLens.wrapRoute(existingHandler)`, or a whole route module with `apiLens.wrapRouteModule({ ... })`. **Bootstrapping alone is insufficient.** Preserve request/params types, runtime, streaming, response headers, caching and business logic.
5. Add `src/app/api/%5F_apilens/[[...segments]]/route.ts` (the `%5F` prefix is required: App Router never routes folders starting with `_`, so `__apilens` would 404; it is still served at `/api/__apilens`) exporting `apiLens.controlRoute()` with `runtime = 'nodejs'` and `dynamic = 'force-dynamic'` when the control plane is used.
6. Inventory all route files and HTTP exports. The FE team previously counted 32 routes; verify the actual count and explicitly list unwrapped/Edge routes. Do not silently convert Edge routes to Node.

`src/middleware.ts` is Edge according to the FE review; it is not an SDK mount point. Do not add a custom Express server or import the SDK into React Client Components.

## 4. Start the server-tracing path

### Remote dev deployment (control plane)

Deploy with `APILENS_ENABLED=true` and a strong `APILENS_CONTROL_TOKEN` (24+ characters, different from any agent token) through the approved configuration mechanism. No local agent is involved.

Build/load the extension with `pnpm --filter @apilens/browser-extension check`, then load `apps/browser-extension/dist` unpacked. In extension **Settings → Instrumented server**, paste the app origin (or the full `/api/__apilens` mount) and the control token, press **Test connection**, then save. Open the **Server API** view and use the application: incoming routes and their upstream calls appear with Sent and Received tabs, and **Simulate a problem** pushes a rule back to the server.

### Local machine (loopback agent)

From ApiLens:

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

Use the printed agent token in CLEAR-APP's approved local process configuration as `APILENS_AGENT_TOKEN`; enable tracing explicitly with `APILENS_ENABLED=true`. Keep these settings out of tracked env files and never use `NEXT_PUBLIC_*` for the token. Restart CLEAR-APP after configuration changes.

In extension Settings: save the same token and connect the agent, then enable **Inject trace headers**. Start a QA session in the CLEAR-APP tab, reload and perform a safe journey. Open **Traces** and expand the calls.

The agent is required only for the loopback path; the control plane replaces it for remote servers. The reporter uses authenticated `POST /v1/spans`, not the old `/api/v1/traces/ingest` URL. `/health` exposes only health information.

## 5. Acceptance and evidence

| Check | Required evidence |
| --- | --- |
| SDK off | Requests and application behavior remain unchanged; no SDK spans |
| SDK on + wrapped route + QA session | Browser span → incoming route span → outbound fetch span(s), with matching trace/session IDs |
| Payloads | Request and response bodies visible in **Server API**, with truncation/redaction flags shown |
| Headers | Diagnostic headers visible; authorization/cookie/token-like values masked before server export |
| Control plane auth | Wrong token returns 401; disabled control plane returns 404 |
| Server mock | Enabled rule changes the upstream result; the call is reported as mocked and `appliedCount` increases |
| Concurrent QA sessions | Calls remain separated by session |
| Abort/error | Original application error preserved; failed span recorded |
| Agent stopped/bad token | Application still works; diagnostics show delivery failure/drop counts |
| Coverage | List each HTTP export wrapped and explain exclusions |

Use scoped tests/typecheck/lint for changed files and the project's approved validation commands; do not run `lint:all` / `build:all` by default. Do not claim CLEAR-APP end-to-end success without observing its real route and fetch spans. ApiLens's own SDK tests use Web Request/Response and a real local agent; they are not a substitute for target-project validation.

## Deployment and safety limits

- The loopback-agent path targets a long-lived local Node process. Preprod server `127.0.0.1` is not the tester's laptop; for a remote deployment use the control plane instead, and never expose the agent publicly.
- The control plane hands captured traffic to anyone holding its token. Use a strong, rotated `APILENS_CONTROL_TOKEN`, keep the control plane off in any environment holding real customer data, and remove it from the deployment when the QA exercise ends. A disabled control plane returns 404 and does not reveal that ApiLens is installed.
- Incoming QA headers are correlation metadata, not access control. Enable only in an approved, access-controlled test environment.
- Server mocks run inside the application process. Never point one at an endpoint with real financial or order side effects, and never fake a successful `submit-order` against preprod. Rules start disabled, live only in process memory, and disappear on restart.
- Captured payloads are redacted on the write path (structural JSON key redaction plus JWT/bearer/card-number patterns) and bounded by `captureBodies.maxBytes`, but this is not a universal PII guarantee. Review route paths, diagnostic headers and payloads before sharing evidence.
- Telemetry is best-effort with bounded queues, timeouts and drop counters. Inspect `apiLens.diagnostics`; use `await apiLens.flush()` in controlled verification. Flush after in-flight work settles before graceful `shutdown()`.

Rollback: disable the server tracing flag (and the control plane) and restart CLEAR-APP; turn off extension trace-header injection and clear the saved control token in extension Settings. No secret should need removing from Git because none should have been committed.

For implementation by Claude, use [the ready-to-copy prompt](claude-clear-app-sdk-prompt.md).
