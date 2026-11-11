# Claude prompt: integrate ApiLens into CLEAR-APP

Copy the complete block below into Claude while working with the CLEAR-APP source checkout. Give Claude access to the ApiLens checkout or the `apilens-next-sdk-0.4.0.tgz` release artifact too.

```text
Integrate @apilens/next-sdk@0.4.0 into CLEAR-APP so ApiLens shows the SERVER
side of every journey (pages, Server Components, server actions, route
handlers, Edge middleware, and the JCS/CMS/auth calls each one makes, with
redacted request and response bodies), not only the browser's traffic.
Do NOT use @apilens/node-sdk (legacy Express SDK) or any 0.1-0.3 instructions.

ApiLens repository: https://github.com/johnson3235/apilens
Authoritative sources, read them fully before writing code:
- sdks/next/README.md (API, the 0.4.0 review-fix table, steps 1, 2 and 3d)
- docs/frontend-sdk-setup.md (CLEAR-APP footprint + acceptance table)
- sdks/next/src/index.ts, src/edge.ts, src/types.ts (real exports and options)
- examples/clear-demo-app (working reference: lib/apilens.ts,
  instrumentation.ts, middleware.ts, scripts/check-live.mjs)
If anything here conflicts with the SDK source, the source wins: tell me.
Do not invent exports, options or npm publication.

0. Confirm the setup (stop and report if it differs)
- Next.js App Router on Next 14.2 with experimental.instrumentationHook,
  a long-lived Node server (standalone container), Edge src/middleware.ts,
  Datadog via --require @vfie/wef-tracing, @vfie/core-networking on global
  fetch, about 33 API routes and about 38 Server Component pages. Record
  what you actually find.

1. Protect existing work
- Read AGENTS.md / CLAUDE.md, git status, branch, remotes, worktrees.
- Do not touch the dirty feat/clear-payg-order-summary checkout, its tracked
  .env.* changes or untracked briefs. Work in a clean worktree on
  chore/adhoc-apilens-qa-setup from develop (check whether it exists first).
- No reset --hard, forced checkout, stash, deletion, edits to tracked .env.*,
  or .env.example. No commit, push or PR unless I ask.

2. Install the package
- Use the next-sdk-v0.4.0 GitHub Release tarball (check its SHA-256) or build
  it: pnpm install --frozen-lockfile; pnpm --filter @apilens/next-sdk build;
  pnpm --filter @apilens/next-sdk test; cd sdks/next; pnpm pack.
- Verify package.json says 0.4.0 and that both '@apilens/next-sdk' and
  '@apilens/next-sdk/edge' resolve.
- Install with CLEAR-APP's own Yarn from the approved artifact location
  (vendor/apilens-next-sdk-0.4.0.tgz if vendoring is allowed, else ask).
  Never commit a lockfile entry pointing at a personal absolute path.

3. Server-only singleton: src/lib/apilens.server.ts
- import 'server-only'; one HMR-safe ApiLensNextSDK on a typed globalThis slot.
- Options:
  serviceName: 'clear-app-bff'
  enabled: process.env.APILENS_ENABLED === 'true'      // off by default
  reportToAgent: false                                 // remote dev server
  allowedAppOrigins: [the real CLEAR-APP dev origin(s), discovered, not guessed]
  captureWithoutSession: true
  captureBodies: { request: true, response: true, maxBytes: 64 * 1024,
                   redactKeys: [CLEAR-specific sensitive keys you find, e.g.
                   contactRef, accountNumber; list what you chose] }
  control: { enabled: true, token: process.env.APILENS_CONTROL_TOKEN ?? '',
             bufferSize: 500, maxBufferBytes: 32 * 1024 * 1024,
             expiresAt: process.env.APILENS_CONTROL_EXPIRES_AT }
  autoInstrument: { ignorePaths: ['/api/check-session'] }
  allowRouteMocks: false
- Pass the token as is: 0.4.0 never throws on a missing or short token, it
  switches the control plane off and reports it in diagnostics.configIssues.
  Do not add your own length gate.
- Datadog agent traffic (:8126, DD_AGENT_HOST, DD_TRACE_AGENT_URL) is ignored
  automatically; add ignoreOutgoing only for other non-QA hosts you find.
- Tokens are server-only secrets: never NEXT_PUBLIC_*, hardcoded, logged,
  committed, or placed in evidence. Never import this module into Client
  Components, hooks or middleware.

4. Boot hook (the only Node wiring)
- In the existing instrumentation.ts register(), inside the
  NEXT_RUNTIME === 'nodejs' branch and after patchConsole():
    const { apiLens } = await import('./lib/apilens.server');
    apiLens.install();
- Do NOT edit page, layout or route files, do NOT add wrapRoute/traceRender,
  and do NOT add a control route file: install() serves /api/__apilens from
  its request hook. Confirm no rewrite/auth layer in front of Next blocks it.

5. Edge middleware
- Wrap the existing exported middleware in src/middleware.ts with
  withApiLens from '@apilens/next-sdk/edge':
    enabled: process.env.APILENS_ENABLED === 'true',
    controlToken: process.env.APILENS_CONTROL_TOKEN,
    serviceName: 'clear-app-middleware',
    captureWithoutSession: true,
    ingestUrl: the pod's own address (e.g. http://127.0.0.1:${PORT}/api/__apilens)
               if the public host does not route back to the same pod.
- Keep the matcher, the logic and the export style unchanged. Confirm the
  env vars are readable in middleware at runtime in this deployment.

6. Verify honestly
- Scoped typecheck, lint and tests per project conventions (not lint:all or
  build:all). Add tests for: SDK disabled = nothing patched and behavior
  unchanged; missing/short token = app boots, /api/__apilens returns 404.
- Run CLEAR-APP locally with APILENS_ENABLED=true and a generated 24+ char
  token in an untracked .env.local or the shell only. Then:
  curl -H "Authorization: Bearer $TOKEN" http://localhost:<port>/api/__apilens/health
  -> sdkVersion 0.4.0, configIssues [].
  Load a session-gated page and an /api route, then GET /api/__apilens/calls:
  expect page call + nested JCS/CMS calls with bodies, a clear-app-middleware
  call with its session/journey calls, msisdn/e-mail redacted, no :8126 calls.
- Extension 1.4.0: Settings -> Instrumented server -> origin + token ->
  Test connection (shows configIssues) -> Start QA session -> reload ->
  Server API -> My session shows only your calls.
- Server mock on a harmless GET only: one 'once' rule -> call marked mocked,
  appliedCount 1. Never mock or fake submit-order or payment endpoints.
- If cluster access, sessions or secrets are missing, finish the safe code and
  tests and state exactly which check remains. Never claim unobserved success.

7. Safety limits
- Dev only, never preprod or prod. The control token exposes redacted
  payloads: set expiresAt or rotate it after each QA exercise.
- Not captured: Next fetch-cache hits (no backend call happened), DB queries,
  Edge route handlers, background jobs. List any you find.

8. Deliverables
- Implement it; do not stop at a plan.
- docs/apilens-qa.md runbook: enable locally and on dev, env var names (no
  values), connecting the extension, rollback (APILENS_ENABLED=false + restart).
- Coverage table: pages, routes, middleware calls observed vs not observed.
- Changed files, branch/worktree, exact commands and results, what was and
  was not verified. Leave everything uncommitted for my review.
```
