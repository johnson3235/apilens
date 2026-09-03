# ApiLens Next SDK 0.1.0 — opt-in QA server tracing

Standalone Node 20+ package. No Next.js runtime dependency, no workspace dependencies, no Express custom server. This is a new adapter; `@apilens/node-sdk` is still the separate legacy Express/http SDK.

## What it captures

- Incoming **wrapped App Router HTTP handlers** (GET/POST/PATCH/etc.) and native/global `fetch` calls executed within their async context.
- Service, method, URL origin/path, status, timing to response headers, request/response headers (credential-like names masked), errors, session/scenario, parent/child trace IDs.
- Promise-based route params and NextRequest subclasses pass through unchanged. Request/response bodies and streams are never consumed by the SDK.

Not automatic visibility into Server Components/SSR, Server Actions, background jobs, Edge middleware, direct `http.request`, DB queries, third-party service internals, or calls made before instrumentation. Every relevant handler must be wrapped. Cached responses are observed as fetch invocations, not necessarily wire requests. Response body and stream-completion timing are not captured. Review URLs/diagnostic headers for application-specific PII before sharing. Queries and URL credentials are omitted.

## Build and distribute from ApiLens

```powershell
pnpm install --frozen-lockfile
pnpm --filter @apilens/next-sdk build
pnpm --filter @apilens/next-sdk test
cd sdks/next
pnpm pack
```

This creates `apilens-next-sdk-0.1.0.tgz`. Copy that tarball to an approved artifact location available to CLEAR-APP (and its CI). It contains compiled JS and TypeScript declarations; no `workspace:*` install is needed. It is not published to npm. Install using the project's Yarn version, for example `yarn add file:./vendor/apilens-next-sdk-0.1.0.tgz` if vendor artifacts are permitted. Do not reference a developer-only absolute path in a committed lockfile.

## CLEAR-APP integration (FE change required)

Preserve the dirty `feat/clear-payg-order-summary` checkout and tracked `.env.*` files. Apply changes in a clean worktree on `chore/adhoc-apilens-qa-setup` based on `develop`, following the FE team's branching guidance. Do not reset or overwrite existing changes; no `.env.example` is required. Use the approved local runtime configuration/secret mechanism, never `NEXT_PUBLIC_*`, for the agent token.

Create `src/lib/apilens.server.ts`:

```ts
import 'server-only';
import { ApiLensNextSDK } from '@apilens/next-sdk';

const processState = globalThis as typeof globalThis & {
  __clearApiLens?: ApiLensNextSDK;
};
export const apiLens = processState.__clearApiLens ??= new ApiLensNextSDK({
  serviceName: 'clear-app-bff',
  enabled: process.env.APILENS_ENABLED === 'true',
  agentToken: process.env.APILENS_AGENT_TOKEN,
  agentUrl: 'http://127.0.0.1:7317',
  allowedAppOrigins: ['http://localhost:3000'], // use the actual approved local origin
  // Optional only for trusted downstream services with their own instrumentation:
  // propagateToOrigins: ['http://localhost:4001'],
});
```

The `server-only` marker must be available in the target Next project. Do not import this module from Client Components or Edge middleware. Restart the server after configuration changes; the singleton avoids duplicated dev/HMR instrumentation.

Merge into `src/instrumentation.ts` (or the appropriate existing instrumentation file):

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { apiLens } = await import('./lib/apilens.server');
    apiLens.installFetch();
  }
}
```

Preserve existing register logic. Follow the target Next version's instrumentation configuration (the repository's Next 14 demo enables `experimental.instrumentationHook`). This boot hook alone does not create a request context. Do not use `src/middleware.ts`, which the FE team identified as Edge.

Wrap **each exported HTTP handler** in the relevant `src/app/api/**/route.ts` files:

```ts
import { apiLens } from '@/lib/apilens.server';
export const runtime = 'nodejs';

async function handleGET(request: Request) {
  // Keep existing handler code unchanged, including fetch/core-networking calls.
  return fetch('http://localhost:4001/api/products');
}
export const GET = apiLens.wrapRoute(handleGET);
```

Wrap existing handlers; the fetch URL above is illustrative, not a replacement for business logic. Keep route params/context signatures and existing runtime declarations; do not convert an Edge route to Node without FE approval. Inventory all HTTP exports in the 32 FE-reported routes and explicitly report any route not covered.

## End-to-end activation

1. Build the ApiLens agent (`pnpm --filter @apilens/agent build`) and run `pnpm agent` on the same machine/network namespace as local Next.js. Use its token for the SDK and extension. **The agent is required for this server-tracing path**, still optional for browser-only capture.
2. Set server runtime `APILENS_ENABLED=true` and `APILENS_AGENT_TOKEN` through approved configuration. Do not commit the token or edit tracked env files as a shortcut.
3. Reload the rebuilt extension. In Settings, save the agent token and connect; explicitly enable **Inject trace headers** for the controlled local app.
4. Start a QA session in the target tab, reload, then trigger a wrapped API. Only same-origin requests in that active session receive QA context.
5. Open Traces, expand a trace and its calls: browser → incoming route → outbound fetch. Inspect status, service, headers, errors and duration.
6. Agent health is `/health`; authenticated ingestion is `/v1/spans`. `apiLens.diagnostics` exposes accepted/dropped counts and a non-secret delivery error. `await apiLens.flush()` helps a controlled test verify delivery.

This version's reporter accepts only a loopback HTTP agent. A deployed preprod server's `127.0.0.1` is NOT the tester's laptop. Remote preprod collection needs an approved collector/forwarding design and service-owner coordination; do not expose an unauthenticated local agent publicly or deploy this debug path broadly. Incoming QA headers are correlation metadata, not authentication: enable only in an access-controlled test environment.

Only explicitly allowlisted downstream origins receive added QA headers; by default downstream headers are not modified. Do not allowlist redirecting endpoints that forward to untrusted services. Credentials already used by the app are never altered. The SDK performs no server mocks; do not fake real submit-order success against preprod.

Telemetry is best-effort, bounded to 1,000 queued spans with batches of 100, a two-second delivery timeout, and observable drop counters. Agent outages do not fail application requests. Flush after in-flight application work settles and then `await apiLens.shutdown()` during graceful termination. Abrupt serverless termination may lose queued spans; this version targets a long-lived local Node server.
