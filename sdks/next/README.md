# ApiLens Next SDK 0.2.0 — opt-in QA server tracing, payload capture and server mocking

Standalone Node 20+ package. No Next.js runtime dependency, no workspace dependencies, no Express custom server. This is a new adapter; `@apilens/node-sdk` is still the separate legacy Express/http SDK.

## What is new in 0.2.0

| Capability | 0.1.0 | 0.2.0 |
|---|---|---|
| Request/response **payloads** | Never captured | Captured, bounded and redacted (`captureBodies`) |
| **Server-side mocking** | Not supported | Rules applied to outbound `fetch` and, optionally, incoming routes |
| Reaching a **remote dev server** | Loopback agent only | In-app control plane over the app's own HTTPS origin |
| Traffic with **no QA session header** | Ignored | Optional (`captureWithoutSession`) |
| Wrapping a route module | One call per HTTP export | `wrapRouteModule(handlers)` |
| **Server-rendered pages** (Server Components) | Not captured | `traceRender(page, load)` — the page and its backend calls |
| **Serverless hosts** (Vercel: pages and API routes in separate functions) | Calls split across functions | `control.relay` forwards them to the control endpoint |

Existing 0.1.0 integrations keep working unchanged; every new capability is opt-in.

## What it captures

- Incoming **wrapped App Router HTTP handlers** (GET/POST/PATCH/etc.) and native/global `fetch` calls executed within their async context.
- Service, method, URL origin/path, redacted query values, status, timing, request/response headers (credential-like names masked), errors, session/scenario, parent/child trace IDs.
- Optionally **request and response payloads**, read from a throwaway `clone()` so the application's own stream is never consumed, capped at `captureBodies.maxBytes`, and redacted before buffering.
- Promise-based route params and NextRequest subclasses pass through unchanged.

Server Components/SSR are captured where their data loading runs inside `traceRender` (see step 3b). Not automatic visibility into unwrapped Server Components, Server Actions, background jobs, Edge middleware, direct `http.request`, DB queries, third-party service internals, or calls made before instrumentation. Every relevant handler must be wrapped. Cached responses are observed as fetch invocations, not necessarily wire requests. Review URLs and diagnostic headers for application-specific PII before sharing.

## Choosing a transport

| Where the Next.js process runs | Use |
|---|---|
| The tester's own machine | Loopback agent (`reportToAgent` on), control plane optional |
| A shared or remote dev server | **Control plane** (`reportToAgent: false`), because that machine's `127.0.0.1` is not the tester's laptop |

Both can be enabled at once. The control plane is what makes payload inspection and mocking possible on a deployed dev environment.

## Build and distribute from ApiLens

```powershell
pnpm install --frozen-lockfile
pnpm --filter @apilens/next-sdk build
pnpm --filter @apilens/next-sdk test
cd sdks/next
pnpm pack
```

This creates `apilens-next-sdk-0.2.0.tgz`. Copy that tarball to an approved artifact location available to CLEAR-APP (and its CI). It contains compiled JS and TypeScript declarations; no `workspace:*` install is needed. It is not published to npm. Install using the project's Yarn version, for example `yarn add file:./vendor/apilens-next-sdk-0.2.0.tgz` if vendor artifacts are permitted. Do not reference a developer-only absolute path in a committed lockfile.

## CLEAR-APP integration (FE change required)

Preserve the dirty `feat/clear-payg-order-summary` checkout and tracked `.env.*` files. Apply changes in a clean worktree on `chore/adhoc-apilens-qa-setup` based on `develop`, following the FE team's branching guidance. Do not reset or overwrite existing changes; no `.env.example` is required. Use the approved local runtime configuration/secret mechanism, never `NEXT_PUBLIC_*`, for tokens.

### 1. The singleton

Create `src/lib/apilens.server.ts`:

```ts
import 'server-only';
import { ApiLensNextSDK } from '@apilens/next-sdk';

const processState = globalThis as typeof globalThis & {
  __clearApiLens?: ApiLensNextSDK;
};

export const apiLens = (processState.__clearApiLens ??= new ApiLensNextSDK({
  serviceName: 'clear-app-bff',
  enabled: process.env.APILENS_ENABLED === 'true',

  // Remote dev server: the tester's loopback agent is unreachable from here.
  reportToAgent: false,

  allowedAppOrigins: ['https://clear-app-dxl-wef-dev-ie.non-prod.example.com'],

  // Shared dev environment: testers cannot inject the QA session header.
  captureWithoutSession: true,

  captureBodies: {
    request: true,
    response: true,
    maxBytes: 128 * 1024,
    redactKeys: ['contactRef', 'msisdn'],
  },

  control: {
    enabled: true,
    token: process.env.APILENS_CONTROL_TOKEN ?? '',
    bufferSize: 500,
  },

  // Optional: let server mocks short-circuit incoming routes too.
  allowRouteMocks: false,
}));
```

The `server-only` marker must be available in the target Next project. Do not import this module from Client Components or Edge middleware. Restart the server after configuration changes; the singleton avoids duplicated dev/HMR instrumentation.

For a **local** setup instead, drop `reportToAgent`/`control` and keep `agentToken: process.env.APILENS_AGENT_TOKEN` plus `agentUrl: 'http://127.0.0.1:7317'`.

### 2. Boot hook

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

### 3. Wrap every HTTP export

```ts
import { apiLens } from '@/lib/apilens.server';
export const runtime = 'nodejs';

async function handleGET(request: Request) {
  // Keep existing handler code unchanged, including fetch/core-networking calls.
  return fetch('https://upstream.example.com/api/products');
}
export const GET = apiLens.wrapRoute(handleGET);
```

For a route file with several verbs, wrap them together:

```ts
export const { GET, POST, PATCH } = apiLens.wrapRouteModule({ GET: handleGET, POST: handlePOST, PATCH: handlePATCH });
```

Keep route params/context signatures and existing runtime declarations; do not convert an Edge route to Node without FE approval. Inventory all HTTP exports in the 32 FE-reported routes and explicitly report any route not covered.

### 3b. Server-rendered pages

When a page loads its data in a Server Component, the browser makes no API call: the backend calls happen on the server while the page is built. Route wrapping cannot see them because there is no Request to wrap. Run the loading inside `traceRender`:

```ts
// src/app/myaccount/billing/page.tsx  (a Server Component)
import { headers } from 'next/headers';
import { apiLens } from '@/lib/apilens.server';

export default async function BillingPage({ searchParams }: { searchParams: { contactId?: string } }) {
  const data = await apiLens.traceRender(
    { path: `/myaccount/billing?contactId=${searchParams.contactId}`, headers: headers() as unknown as Headers },
    () => loadBilling(searchParams.contactId), // existing fetches, unchanged
  );
  return <Billing data={data} />;
}
```

The extension's **Server API** view then shows `GET /myaccount/billing` as a page call, with every backend fetch made inside it listed underneath. Server mocks apply to those backend calls. Notes:

- `headers` provides the host, the QA session and any incoming `traceparent`.
- A plain-object result is captured as the page call's *Received* body. A rendered React element is not.
- Next's `redirect()` and `notFound()` are recorded as 307 and 404. Its internal control-flow errors are not recorded.
- Nested calls (a layout and its page, say) count as one page call.

### 3c. Serverless hosts (Vercel)

Vercel runs App Router pages and route handlers as **separate functions with separate memory**. The control route lives in one function, while a page's captures land in another. Turn on relay:

```ts
control: {
  enabled: true,
  token: process.env.APILENS_CONTROL_TOKEN ?? '',
  relay: process.env.VERCEL === '1' ? {} : undefined, // or { url, headers }
},
```

A process that has not served the extension itself then does three things:

- It posts its captures to `<request origin>/api/__apilens/ingest`.
- It reads the mock rules from `/rules` before each request or render.
- It reports rule uses to `/consume`, so *only the next call* rules still fire once across functions.

The process the extension polls keeps its captures locally. Relay failures never break a page; `diagnostics.relayFailures` and `diagnostics.lastRelayError` say why. On a single Node server (`next start`, a container) leave `relay` unset.

### 4. Mount the control plane

Create `src/app/api/%5F_apilens/[[...segments]]/route.ts`. The folder name is deliberate: the App Router treats any folder starting with `_` as private and never routes it, so a literal `__apilens` folder silently returns 404. `%5F` is Next's URL-encoded underscore, and the route is served at `/api/__apilens`.

```ts
import { apiLens } from '@/lib/apilens.server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, DELETE, OPTIONS } = apiLens.controlRoute();
```

`dynamic = 'force-dynamic'` matters: a cached control response would serve stale captures.

## Control plane API

All routes require `Authorization: Bearer <control token>` (or `x-apilens-control-token`). Responses are `no-store` and `noindex`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/__apilens/health` | Protocol/SDK version, capture configuration, buffer and rule counts |
| `GET` | `/api/__apilens/calls?since=<seq>&limit=<n>` | Captured calls newer than a cursor, with `gap` when the buffer rolled over |
| `DELETE` | `/api/__apilens/calls` | Clear the buffer |
| `GET` | `/api/__apilens/rules` | Current server mock rules |
| `PUT` | `/api/__apilens/rules` | Replace the rule set (max 100) |
| `DELETE` | `/api/__apilens/rules` | Remove all rules |
| `POST` | `/api/__apilens/ingest` | Calls relayed by another function of the same app (`{ calls }`, max 50) |
| `POST` | `/api/__apilens/consume` | Rule uses from another function, for apply budgets (`{ ruleIds }`) |

Security properties:

- The token is compared in constant time against a SHA-256 digest, so its length and content cannot be probed by timing.
- Ten consecutive failures trigger a one-minute lockout; 600 requests per minute are allowed in total.
- When `control.enabled` is false, or the token is shorter than 24 characters, every request returns `404` — a disabled control plane never advertises that ApiLens is installed.
- `control.token` must differ from `agentToken`, so a leaked control token cannot be replayed against the agent.
- CORS headers are emitted **only** for origins listed in `control.allowedOrigins`. The browser extension authenticates by token and needs no entry there.

This endpoint exposes captured traffic to anyone holding the token. Treat the token as a production-grade secret, keep the control plane off in any environment holding real customer data, and remove it from the deployment when the QA exercise ends.

## Server mocking

Rules are evaluated inside the Node process, between the route handler and its upstream services — the failures a browser mock can never reach.

```ts
apiLens.setServerMockRules([
  {
    id: 'billing-down',
    name: 'Billing service 503',
    enabled: true,
    priority: 10,
    match: { method: 'GET', urlPattern: '*/v2/billing/*', matchType: 'glob', kind: 'client' },
    action: { type: 'status-code', statusCode: 503, delayMs: 250 },
    applyMode: 'once',
  },
]);
```

| Action | Effect |
|---|---|
| `status-code` | Return a failure status without calling upstream |
| `custom-body` | Return a body you control |
| `empty-response` | Success status, no payload |
| `invalid-json` | Truncated payload that fails to parse |
| `network-error` | Reject like a refused connection (`TypeError: fetch failed`) |
| `timeout` | Hang, then fail |
| `passthrough-mutate` | Call upstream, then apply `fieldMutations` and/or `delayMs` to the real response |

Safety behaviour:

- Rules arriving over the control plane are normalised: unknown action types, out-of-range status codes and oversized patterns are clamped, and `appliedCount` is preserved server-side so a UI round-trip cannot reset an apply budget.
- A malformed pattern matches nothing rather than everything.
- Non-ASCII rule names are made header-safe, and a rule that cannot produce a response falls back to the real call rather than breaking the request.
- An aborted caller is honoured immediately, including during a simulated delay.
- Incoming routes are only short-circuited when `allowRouteMocks: true`.
- Rules live in process memory and vanish on restart, so a forgotten mock cannot outlive a deployment.

Never point server mocks at an endpoint with real financial or order side effects, and never fake a successful `submit-order` against preprod.

## Payload capture and redaction

`captureBodies` accepts `{ request, response, maxBytes, contentTypes, redactKeys, includeBinary }`.

- Bodies are read from a `clone()` branch; the application's stream is untouched and the tee's cancel promise is never awaited — awaiting it deadlocks until *both* branches cancel.
- Recording happens off the request's critical path, so payload capture never adds latency to the application response. `await apiLens.flush()` drains it in a controlled test.
- Oversized payloads are truncated and flagged, never silently dropped. Binary content types are skipped with a stated reason unless `includeBinary` is on.
- Redaction runs on the write path, before anything is buffered: JSON is walked structurally so sensitive keys are removed even when their values look ordinary, and JWTs, bearer tokens and card-like digit runs are replaced wherever they appear.
- Every omission carries a human-readable reason that the extension displays, so a blank payload panel is never ambiguous.

Redaction is a strong default, not a universal PII guarantee. Review captured payloads before attaching them to a defect.

## End-to-end activation

1. Deploy CLEAR-APP with `APILENS_ENABLED=true` and a strong `APILENS_CONTROL_TOKEN` through approved configuration. Do not commit the token or edit tracked env files as a shortcut.
2. Build and load the extension (`pnpm --filter @apilens/browser-extension check`, then load `apps/browser-extension/dist` unpacked).
3. Open DevTools → **ApiLens** → **Settings** → *Instrumented server*. Paste the app origin (or the full `/api/__apilens` mount) and the control token, then use **Test connection** before saving.
4. Open **Server API**. Use the application; incoming routes and their upstream calls appear within a poll interval, with Payload and Response tabs.
5. Select a call → **Simulate a problem** → choose what should go wrong → **Save and turn on**. Rules created from a call apply to the next matching call only, unless the tester chooses *Every call*.
6. **Traces** correlates server spans with browser requests for the same journey.

For the local agent path instead: run `pnpm --filter @apilens/agent build` and `pnpm agent`, keep `agentToken`, and inspect **Traces** as in 0.1.0. `apiLens.diagnostics` exposes accepted/dropped counts and a non-secret delivery error.

Telemetry is best-effort, bounded to 1,000 queued spans with batches of 100, a two-second delivery timeout, and observable drop counters. Agent outages do not fail application requests. Flush after in-flight application work settles and then `await apiLens.shutdown()` during graceful termination. Abrupt serverless termination may lose queued spans and in-memory captures; this version targets a long-lived Node server.
