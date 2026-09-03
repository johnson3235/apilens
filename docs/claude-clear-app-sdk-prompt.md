# Claude prompt: integrate ApiLens into CLEAR-APP

Copy the complete block below into Claude while working with the CLEAR-APP source checkout. Give Claude access to the updated ApiLens checkout or its built SDK tarball too.

```text
Implement controlled local QA server tracing in CLEAR-APP using the NEW
@apilens/next-sdk@0.1.0. Do not use @apilens/node-sdk (the legacy Express SDK).

ApiLens repository: https://github.com/johnson3235/apilens
Local ApiLens checkout, if available:
C:\Users\YoussefJ\Documents\GitHub\New_Github_Cloud\apilens-main
SDK source: sdks/next
SDK artifact: sdks/next/apilens-next-sdk-0.1.0.tgz
Authoritative instructions: sdks/next/README.md and docs/frontend-sdk-setup.md.
Read those files and the SDK exports before implementation. If the local path
is unavailable, obtain the source from the repository through authorized access
or ask for the artifact. Do not invent package exports or npm publication.

1. Inspect and protect the repository
- Read applicable AGENTS.md instructions, package.json, Yarn configuration,
  Next version, tsconfig, next.config, instrumentation, route handlers and
  existing tests. Check git status, branch, remotes and worktrees.
- The FE team reports 32 App Router /api routes, native fetch via
  @vfie/core-networking@0.0.594, no custom server, and Edge src/middleware.ts.
  Verify these observations against this checkout.
- Do not modify or commit onto feat/clear-payg-order-summary. It has been
  reported to contain tracked .env.development changes and untracked briefs.
- Use a separate clean worktree on chore/adhoc-apilens-qa-setup from develop.
  Inspect whether the branch/worktree already exists before creating it;
  never overwrite or repurpose another dirty worktree.
- Preserve existing edits. No reset --hard, forced checkout, automatic stash,
  deletion of briefs, or modification of tracked .env.* files.
- Do not create .env.example. Do not commit/push or open a PR unless I ask.

2. Install the correct portable SDK
- @apilens/next-sdk is not published to npm. Do not run an unverified registry
  install or try to install the old workspace:* package directly with Yarn.
- If necessary, build/pack from the ApiLens checkout:
  pnpm install --frozen-lockfile
  pnpm --filter @apilens/next-sdk build
  pnpm --filter @apilens/next-sdk test
  Then run pnpm pack from sdks/next.
- Install the resulting tarball using CLEAR-APP's existing Yarn version and
  approved artifact policy. If vendor artifacts are allowed, a relative
  file:./vendor/apilens-next-sdk-0.1.0.tgz dependency is suitable.
- The artifact must be available to CI. Never commit a dependency/lockfile
  reference to a developer-only absolute path. If distribution policy is
  unclear, ask for the approved location rather than publishing externally.

3. Create one server-only singleton
- Add a module such as src/lib/apilens.server.ts protected by server-only.
  Confirm the marker dependency is available and respect current conventions.
- Import { ApiLensNextSDK } from '@apilens/next-sdk'.
- Reuse one singleton across development HMR, using a typed globalThis slot.
- Constructor options:
  serviceName: 'clear-app-bff'
  enabled: process.env.APILENS_ENABLED === 'true'
  agentToken: process.env.APILENS_AGENT_TOKEN
  agentUrl: 'http://127.0.0.1:7317'
  allowedAppOrigins: [the actual approved local CLEAR-APP origin]
- Do not guess the port. Discover it from the current dev configuration.
- Keep propagateToOrigins empty unless downstream propagation is explicitly
  approved. Outbound fetch calls are still captured without adding headers to
  downstream services. Never change Authorization or application credentials.
- Never import the SDK into Client Components, hooks or browser code.
- The token is a server-only secret: no NEXT_PUBLIC_ prefix, hardcoded value,
  committed env file, logging of its value or inclusion in evidence.
- Document approved runtime configuration and restart requirements without
  writing tokens into tracked files. Remain disabled by default.

4. Integrate the Node boot hook AND route context
- Merge with the existing instrumentation.ts register() function, preserving
  current instrumentation. Under process.env.NEXT_RUNTIME === 'nodejs',
  dynamically import the singleton and call apiLens.installFetch().
- Check the installed Next version and enable instrumentation only if its
  documented configuration requires it. Do not blindly add obsolete flags.
- Do not use Edge src/middleware.ts as the mount point. Do not invent an
  Express custom server or silently change Edge routes to Node runtime.
- Instrumentation boot alone is insufficient: each relevant HTTP export in
  app/api/**/route.ts or src/app/api/**/route.ts needs wrapping:
  export const GET = apiLens.wrapRoute(existingGETHandler);
  Use the same pattern for POST, PUT, PATCH, DELETE, HEAD and OPTIONS where
  they actually exist. Preserve request/NextRequest types and the params
  context signature, including Promise-based params when applicable.
- Keep route business logic, authentication, cookies, headers, returned
  Response/NextResponse, body streaming, abort signals and caching unchanged.
  Existing core-networking/fetch calls must remain unchanged.
- Inventory every route file and HTTP export, and report wrapped vs excluded
  handlers. Do not claim all 32 routes are covered without checking exports.

5. Verify the integration honestly
- Run scoped tests, typecheck and scoped lint using the project's conventions.
  Do not run lint:all or build:all by default or weaken their rules.
- Test enabled/disabled behavior, missing QA headers, preserved params and
  responses, fetch errors/aborts, concurrent sessions, and SDK import isolation.
- For local integration, build and start the ApiLens agent in its repository:
  pnpm --filter @apilens/agent build
  pnpm agent
- Agent is required for SERVER spans, not for browser-only extension capture.
  Use the same token for the SDK and extension Settings. Do not print it.
- The ingestion endpoint is authenticated POST /v1/spans, not the old
  /api/v1/traces/ingest. Health is /health.
- Build/reload apps/browser-extension/dist, connect the agent in Settings,
  enable Inject trace headers, start a QA session in the target app tab and
  reload. Trigger an approved local route. Expand Traces and verify browser
  -> incoming route -> outbound fetch with matching parent/session IDs.
- Check apiLens.diagnostics and use await apiLens.flush() in a controlled
  test to verify delivery. A stopped agent or bad token must not break the app.
- Verify credential-like header values are masked and diagnostic headers
  remain visible. Review application-specific PII before sharing.
- Do not claim CLEAR-APP E2E success if browser/server access or local secrets
  are missing. Finish safe code/tests and state the exact remaining check.

6. Safety and coverage boundaries
- Local long-lived Node runtime is the supported deployment for this version.
  A remote preprod server's localhost is NOT the tester's laptop. Stop and
  request the approved collection design before remote/preprod deployment.
  Do not expose the agent publicly or weaken authentication/network controls.
- Do not mock preprod or fake a real submit-order success during validation.
- This captures wrapped HTTP handlers and global/native fetch within their
  QA async context, not automatically SSR/Server Components, Server Actions,
  Edge, background jobs, DB queries, direct http.request or other services'
  internal calls. Cached fetch invocations are not necessarily wire requests.
- Response bodies and stream-completion timing are not captured. Telemetry
  is bounded/best-effort; dropped span diagnostics must not be hidden.
- Do not expand into these missing capabilities without separate approval.

7. Deliverables
- Implement the scoped integration; do not stop at a plan.
- Add a concise CLEAR-APP setup/runbook and route coverage inventory.
- List changed files, the actual worktree/branch, exact test commands/results,
  how to activate tracing without committing secrets, and rollback steps.
- Report what was and was not verified against the running CLEAR-APP app.
- Leave changes uncommitted for review unless I explicitly request a commit.
```
