# CLEAR-APP frontend handoff: ApiLens server tracing

## Requested change

Integrate **`@apilens/next-sdk@0.1.0`** in the Node runtime of CLEAR-APP. Do **not** install the legacy `@apilens/node-sdk`: it is an Express/http adapter, not the App Router adapter.

The new SDK records wrapped App Router HTTP handlers and native/global `fetch` calls made inside their QA context. It records service, method, URL origin/path, status, time to response headers, sanitized headers, errors and parent/child trace IDs. It does not capture response bodies, DB queries, Server Actions/SSR, background jobs, direct `http.request`, Edge execution or downstream service internals automatically. Cached fetch results are not proof of an actual backend network call.

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

Output: `sdks/next/apilens-next-sdk-0.1.0.tgz`. Generated dist/tarballs are not committed; a GitHub source checkout must be built. This package is not published to npm and has no runtime or `workspace:*` dependencies.

Make the artifact available through the team's approved distribution process. If checked-in vendor artifacts are allowed, put it at `CLEAR-APP/vendor/apilens-next-sdk-0.1.0.tgz`, then use the project's Yarn version:

```powershell
yarn add file:./vendor/apilens-next-sdk-0.1.0.tgz
```

Keep the artifact available to CI; do not commit a lockfile pointing at a personal absolute path. If vendor artifacts are prohibited, agree on an approved package/artifact registry instead; do not silently publish it.

## 3. Add server-only integration

Follow the code in the [SDK README](../sdks/next/README.md):

1. Create one HMR-safe `ApiLensNextSDK` singleton in `src/lib/apilens.server.ts`, protected by `server-only`.
2. Use `enabled: process.env.APILENS_ENABLED === 'true'`, server-only `APILENS_AGENT_TOKEN`, and the actual approved local origin in `allowedAppOrigins`.
3. Merge Node-only `installFetch()` bootstrapping into the existing `instrumentation.ts`; preserve other instrumentation. Follow the installed Next version's configuration requirements.
4. Wrap each relevant exported GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS handler with `apiLens.wrapRoute(existingHandler)`. **Bootstrapping alone is insufficient.** Preserve request/params types, runtime, streaming, response headers, caching and business logic.
5. Inventory all route files and HTTP exports. The FE team previously counted 32 routes; verify the actual count and explicitly list unwrapped/Edge routes. Do not silently convert Edge routes to Node.

`src/middleware.ts` is Edge according to the FE review; it is not an SDK mount point. Do not add a custom Express server or import the SDK into React Client Components.

## 4. Start the local server-tracing path

From ApiLens:

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

Use the printed agent token in CLEAR-APP's approved local process configuration as `APILENS_AGENT_TOKEN`; enable tracing explicitly with `APILENS_ENABLED=true`. Keep these settings out of tracked env files and never use `NEXT_PUBLIC_*` for the token. Restart CLEAR-APP after configuration changes.

Build/load the extension with `pnpm --filter @apilens/browser-extension check`, then load `apps/browser-extension/dist` unpacked. After rebuilding, reload the extension and target tab.

In extension Settings: save the same token and connect the agent, then enable **Inject trace headers**. Start a QA session in the CLEAR-APP tab, reload and perform a safe journey. Open **Traces** and expand the calls.

The agent is **required for server telemetry**, but remains optional for browser-only capture. The reporter uses authenticated `POST /v1/spans`, not the old `/api/v1/traces/ingest` URL. `/health` exposes only health information.

## 5. Acceptance and evidence

| Check | Required evidence |
| --- | --- |
| SDK off | Requests and application behavior remain unchanged; no SDK spans |
| SDK on + wrapped route + QA session | Browser span → incoming route span → outbound fetch span(s), with matching trace/session IDs |
| Headers | Diagnostic headers visible; authorization/cookie/token-like values masked before server export |
| Concurrent QA sessions | Calls remain separated by session |
| Abort/error | Original application error preserved; failed span recorded |
| Agent stopped/bad token | Application still works; diagnostics show delivery failure/drop counts |
| Coverage | List each HTTP export wrapped and explain exclusions |

Use scoped tests/typecheck/lint for changed files and the project's approved validation commands; do not run `lint:all` / `build:all` by default. Do not claim CLEAR-APP end-to-end success without observing its real route and fetch spans. ApiLens's own SDK tests use Web Request/Response and a real local agent; they are not a substitute for target-project validation.

## Deployment and safety limits

- This release targets a long-lived local Node process and a loopback HTTP agent. Preprod server `127.0.0.1` is not the tester's laptop. Remote collection needs an approved infrastructure design; do not expose the agent publicly or disable network/authentication protections.
- Incoming QA headers are correlation metadata, not access control. Enable only in an approved, access-controlled test environment.
- Do not mock preprod or fake successful real `submit-order` calls. Server tracing does not require server mocking.
- Review route paths and custom diagnostic headers for application-specific PII before sharing evidence. The SDK drops query strings and masks credential-like header names, but this is not a universal PII guarantee.
- Telemetry is best-effort with bounded queues, timeouts and drop counters. Inspect `apiLens.diagnostics`; use `await apiLens.flush()` in controlled verification. Flush after in-flight work settles before graceful `shutdown()`.

Rollback: disable the server tracing flag and restart CLEAR-APP; turn off extension trace-header injection. No secret should need removing from Git because none should have been committed.

For implementation by Claude, use [the ready-to-copy prompt](claude-clear-app-sdk-prompt.md).
