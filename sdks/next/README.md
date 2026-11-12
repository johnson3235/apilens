# ApiLens Next SDK 0.5.0 — opt-in QA server tracing, payload capture and server mocking

Standalone Node 20+ package. No Next.js runtime dependency, no workspace dependencies, no Express custom server. This is a new adapter; `@apilens/node-sdk` is still the separate legacy Express/http SDK.

## What is new in 0.5.0: "connected, but no server calls"

A tester could link the extension, see it connected, and still get an empty list with no way to tell why. 0.5.0 makes the server explain itself, and closes the three gaps left open in 0.4.0.

| Problem | 0.5.0 |
|---|---|
| Connected, but nothing captured, and no reason given | `/health` carries a **`capture` block**: requests seen and recorded, and how many were skipped because of `ignorePaths`, a missing QA session, an origin outside `allowedAppOrigins`, or no backend call, plus the last rejected origin. The extension turns it into a checklist with the exact config line to copy. |
| An ingress rewrites the host, so every request is dropped by `allowedAppOrigins` | An origin the extension reached the control plane through with a valid token is **accepted automatically** (reported as `learnedOrigins`). Anything still rejected is counted and named. |
| `register()` never runs (Next 14 without `experimental.instrumentationHook`), and only an old control route file answers | The first authenticated control request **installs capture itself**, and `configIssues` says so, because earlier requests were missed and it happens after every restart. |
| Middleware calls appeared as separate entries | The Edge wrapper hands its run id to the page through Next's request-header override (`x-apilens-middleware`); the page **continues that trace** and records `middlewareSpanId`, and the extension shows the run, and its calls, under the page. |
| Responses Next served from its fetch cache were invisible | A layer above Next's (and React's) fetch patch records them as calls with **`cache: 'hit'`**, with the data the page received. Verified on Next 14.2.35, including in-render deduplication. |
| Several replicas: the extension only saw one, and each pod switch wiped the list | `calls?cursors=<processId>:<seq>,…` lets each pod read its own cursor. Extension 1.5.0 polls them all, merges by span id, and re-applies a saved mock to pods that missed the save. |

Upgrading needs no code change.

## What was new in 0.4.0: hardening from the CLEAR-APP review

Every item raised in the 0.3.0 review of the CLEAR-APP spike is addressed. Upgrading needs no code change; each new behaviour is safe by default.

| Review finding | 0.4.0 |
|---|---|
| A short or missing control token threw in the constructor and stopped boot, even with the SDK off | **Never throws.** The affected feature is switched off and reported in `diagnostics.configIssues`, the control plane's `/health` and one `console.warn` (no secret values). While `enabled` is false nothing is validated or reported. |
| The control plane needed its own route file | **Served by the request hook** at `control.path` (default `/api/__apilens`) before Next routes the request. The app footprint is the singleton and two lines in `instrumentation.ts`. The route file is only needed with `control.relay` (serverless). |
| Edge middleware (session, journey, `billingAccountMiddleware`) was invisible | **`@apilens/next-sdk/edge`**: `withApiLens(middleware, options)` records the middleware run and its `fetch` calls inside the Edge sandbox and posts them to the control plane. See step 3d. |
| Datadog agent calls appeared under random requests; no outgoing filter | **`ignoreOutgoing`** (hosts, `host:port`, `:port`, URL prefixes, RegExp). Tracer agents (`:8126`, OTLP `:4317/:4318`, `DD_AGENT_HOST`, `DD_TRACE_AGENT_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`) are always ignored. |
| Background work inherited the in-flight request's context | Calls that **start after the response finished** are skipped and counted (`diagnostics.lateCallsSkipped`); `autoInstrument.recordAfterResponse: true` keeps them. |
| Worst case ≈ 128 MB held in the pod | **`control.maxBufferBytes`** (default 32 MB) caps buffered captures; oldest are evicted first, and `/health` reports `bufferedBytes`. |
| Synchronous gunzip/brotli on the event loop | Decompression runs **asynchronously** on libuv's thread pool. |
| Process-wide patches stayed until shutdown | `shutdown()` now **restores** `http.request`/`get`, `Server.emit` and `fetch`, unless another library wrapped them since (then the patch stays, inert). |
| Shared server mixed every tester's traffic into one session | Extension 1.4.0 **tags the recording tab's own requests** (page loads, RSC, server actions, fetch) with `x-qa-session-id`; the Server API view defaults to **My session**. |
| Redaction matched key substrings only | Adds `msisdn`, phone/mobile, e-mail, date-of-birth keys (whole-key, so `mobilePlanName` survives) and **e-mail and IBAN values** anywhere in a payload. |
| Token rotation relied on discipline | **`control.expiresAt`**: after it, the control plane answers 404. |
| Not on npm | `.github/workflows/next-sdk-release.yml` builds, tests and attaches the tarball to a GitHub Release on a `next-sdk-v*` tag. |

## What was new in 0.3.0: zero-touch capture

One boot hook in `instrumentation.ts` now captures **every** incoming request (page renders, RSC payloads, Server Components, server actions and route handlers) together with the backend `fetch` calls it makes. Page, layout and route files never change. A new page is covered the moment it exists.

| | 0.2.0 | 0.3.0 |
|---|---|---|
| Server-rendered pages | `traceRender` in every page | Automatic |
| Route handlers | `wrapRoute` on every export | Automatic |
| Server actions | Not captured | Automatic |
| Choosing what is captured | Edit the code | `autoInstrument` config |
| axios, got, node-fetch, superagent, SOAP/vendor SDKs (Node `http`/`https`) | Not captured | Automatic, including server mocks |

How it works: `next start`, `next dev`, standalone output and custom servers all serve through Node's `http.Server`. The SDK hooks its `request` event once, opens a capture context per request, and the global `fetch` wrapper records every call made inside it. Request bodies are copied as Node's parser delivers them and response bodies as they are written, so application streams are never consumed. gzip/deflate/br responses are decoded for display.

Backend calls are captured whichever client makes them: global `fetch`, or any library built on Node's `http`/`https` modules (axios, got, node-fetch, superagent, most vendor SDKs). For those clients:

- **No matching mock:** the application gets the real `ClientRequest`, only observed. The SDK adds no event listeners, so Node's handling of unread responses and unhandled errors is unchanged.
- **Mocks:** server mocks answer them too, with a stand-in request object. `network-error` surfaces as `ECONNREFUSED`, the way axios reports a refused connection.
- **Limits:** rules that match on the request body (`bodyContains`) do not apply to these clients, because the choice between real and mocked is made when the request is created. The panel shows that reason. Turn this off with `captureNodeHttp: false`.

Upgrading from 0.2.0 needs no code change: the existing `installFetch()` call turns automatic capture on. Existing `wrapRoute`/`traceRender` calls keep working. When one runs inside an automatically captured request, the call is recorded once.

```ts
autoInstrument: {
  ignorePaths: ['/api/health', /^\/internal\//], // string = path prefix
  recordAllRequests: false, // default: skip GET page loads that made no backend call
},
// autoInstrument: false restores the 0.2.0 behaviour.
```

Always skipped: `/_next/*`, Next dev tooling, static files, `favicon.ico` and the control endpoint. A request with no backend call is recorded only when it failed, was not a GET/HEAD (server actions, form posts) or is under `/api/`, unless `recordAllRequests` is on. Next's `_rsc` cache-buster is removed from recorded URLs, and HTML/RSC markup bodies are not captured.

## What was new in 0.2.0

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

- **Every incoming Node-runtime request** (pages, Server Components, server actions, route handlers) and the native/global `fetch` calls executed while handling it.
- Service, method, URL origin/path, redacted query values, status, timing, request/response headers (credential-like names masked), errors, session/scenario, parent/child trace IDs.
- Optionally **request and response payloads**, read from a throwaway `clone()` so the application's own stream is never consumed, capped at `captureBodies.maxBytes`, and redacted before buffering.
- Promise-based route params and NextRequest subclasses pass through unchanged.

- **Edge middleware**, through `@apilens/next-sdk/edge` (step 3d).

Not captured: Edge-runtime *route handlers*, background jobs outside a request (and, by default, calls that start after the response was sent), DB queries, gRPC/raw TCP clients, third-party service internals, and the first request `next dev` handles before `register()` has run.

**Next fetch-cache hits** (0.5.0+) are recorded with `cache: 'hit'`: the global `fetch` becomes an accessor, so Next's and React's patches install underneath a thin layer that notices when a call came back without reaching the network. No backend call happened, so mocks do not apply to them. Review URLs and diagnostic headers for application-specific PII before sharing.

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

This creates `apilens-next-sdk-0.5.0.tgz`. It contains compiled JS and TypeScript declarations, has no runtime dependencies and needs no `workspace:*` install. It is not published to npm.

Two ways to make it available to CLEAR-APP and its CI:

- **GitHub Release (recommended).** Pushing a tag `next-sdk-v0.5.0` runs `.github/workflows/next-sdk-release.yml`, which builds, tests, packs and attaches `apilens-next-sdk-0.5.0.tgz` and its SHA-256 to a release. Install from the release URL (`yarn add https://github.com/<owner>/apilens/releases/download/next-sdk-v0.5.0/apilens-next-sdk-0.5.0.tgz`), or mirror it into the approved artifact registry. A private repository needs an authenticated download, so mirroring is usually simpler.
- **Vendored tarball.** If vendor artifacts are permitted: `yarn add file:./vendor/apilens-next-sdk-0.5.0.tgz`.

Never reference a developer-only absolute path in a committed lockfile.

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
    // Missing or short: the control plane stays off and the app still boots.
    token: process.env.APILENS_CONTROL_TOKEN ?? '',
    bufferSize: 500,
    maxBufferBytes: 32 * 1024 * 1024, // memory ceiling for captures in this pod
    expiresAt: process.env.APILENS_CONTROL_EXPIRES_AT, // e.g. 2026-11-30T18:00:00Z
  },

  // Datadog and OTLP agents are always ignored; add anything else that is not QA traffic.
  ignoreOutgoing: ['launchdarkly.com', /\/healthz$/],

  autoInstrument: {
    ignorePaths: ['/api/check-session'], // the 60 s session poll would flood the buffer
  },

  // Optional: let server mocks short-circuit incoming routes too.
  allowRouteMocks: false,
}));
```

Configuration problems never stop the app. `apiLens.diagnostics.configIssues` lists what was switched off and why (for example a short token), and the extension's Settings → *Test connection* shows the same list.

The `server-only` marker must be available in the target Next project. Do not import this module from Client Components or Edge middleware. Restart the server after configuration changes; the singleton avoids duplicated dev/HMR instrumentation.

For a **local** setup instead, drop `reportToAgent`/`control` and keep `agentToken: process.env.APILENS_AGENT_TOKEN` plus `agentUrl: 'http://127.0.0.1:7317'`.

### 2. Boot hook

Merge into `src/instrumentation.ts` (or the appropriate existing instrumentation file):

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { apiLens } = await import('./lib/apilens.server');
    apiLens.install();
  }
}
```

Preserve existing register logic. Follow the target Next version's instrumentation configuration (the repository's Next 14 demo enables `experimental.instrumentationHook`).

**This is the whole Node integration.** Every page, Server Component, server action and route handler is captured with its backend calls, and the control plane is served from the same hook, so no route file is needed. Do not edit page, layout or route files. Steps 3–3c are optional refinements; step 3d adds Edge middleware.

### 3. Optional: wrap a route explicitly

Only needed for `allowRouteMocks` (mocking the incoming route itself) or with `autoInstrument: false`:

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

Keep route params/context signatures and existing runtime declarations; do not convert an Edge route to Node without FE approval.

### 3b. Optional: `traceRender` for a page's loaded data

Server-rendered pages are captured automatically. `traceRender` adds one thing: the data a page loaded becomes the page call's *Received* body. It also works with `autoInstrument: false`:

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

### 3d. Edge middleware

Next 14 runs `src/middleware.ts` in the Edge sandbox, with its own `fetch` and no Node `http`, so the Node hooks above never see its calls (session creation, journey bootstrap, `billingAccountMiddleware`). Wrap the exported middleware once:

```ts
// src/middleware.ts
import { withApiLens } from '@apilens/next-sdk/edge';

async function middleware(request: NextRequest) {
  // existing middleware, unchanged
}

export default withApiLens(middleware, {
  enabled: process.env.APILENS_ENABLED === 'true',
  controlToken: process.env.APILENS_CONTROL_TOKEN,
  serviceName: 'clear-app-middleware',
  captureWithoutSession: true,
  // Behind a load balancer, deliver to this pod rather than the public host:
  // ingestUrl: `http://127.0.0.1:${process.env.PORT ?? 3000}/api/__apilens`,
});
export const config = { /* existing matcher, unchanged */ };
```

(Keep whichever export style the file uses: `export const middleware = withApiLens(...)` works the same.)

- Each run whose middleware made a backend call, redirected (3xx) or failed is recorded as a call from `serviceName`, with its `fetch` calls (bodies redacted, 32 KB each by default) nested under it.
- Captures are posted to the control plane's `/ingest` through `event.waitUntil`, so the response is never delayed; a failed delivery is dropped silently.
- Disabled, or with a token under 24 characters, `withApiLens` returns the middleware unchanged. The `/edge` entry imports nothing from Node.
- Server mocks do not apply inside middleware: rules live in the Node process.
- A run that made a backend call is linked to the page it let through (0.5.0+): the wrapper adds `x-apilens-middleware` to the forwarded request with the same `x-middleware-override-headers` mechanism as `NextResponse.next({ request: { headers } })`, keeping every incoming header listed. Redirects and runs without backend calls are left untouched.

### Troubleshooting: connected, but no server calls

Open **Server calls** in the extension. With an empty list it shows the server's own diagnosis (from `/health` → `capture`); the same data is available from the command line:

```bash
curl -s -H "authorization: Bearer $APILENS_CONTROL_TOKEN" https://<app>/api/__apilens/health | jq .capture
```

| What it says | Cause | Fix |
|---|---|---|
| `installed: false` | `register()` did not call `install()` | Call it from `instrumentation.ts`; on Next 14 set `experimental.instrumentationHook: true` |
| `installedBy: "first-connection"` | Same, recovered at connection time | Same fix, or every restart misses requests again |
| `requestsSeen: 0` | No page request reached this process | Reload a page; with several replicas, check the others are polled (`pods` in the extension) |
| `skipped.originNotAllowed` > 0 | Requests arrive as `lastRejectedOrigin` | Add it to `allowedAppOrigins`, or connect the extension through that address |
| `skipped.noSession` > 0 | No `x-qa-session-id` and `captureWithoutSession` off | Record a QA session with *Tag my traffic* on, or set `captureWithoutSession: true` |
| `skipped.noBackendCall` > 0, `backendCalls: 0` | The pages fetch their data from the browser | Look under **Browser calls** |

### 4. Optional: mount the control plane as a route

Only needed with `control.relay` (serverless hosts), where the extension must reach one specific function. On a single Node server the request hook serves the control plane itself; a route file, if present, is simply never reached. If it *is* reached, `install()` never ran: from 0.5.0 the route installs capture on the first connection and `configIssues` reports it.

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
- When `control.enabled` is false, the token is shorter than 24 characters, or `control.expiresAt` has passed, every request returns `404` — a disabled control plane never advertises that ApiLens is installed. An unreadable `expiresAt` counts as expired.
- `control.token` must differ from `agentToken`, so a leaked control token cannot be replayed against the agent. A reused token switches the control plane off (reported in `configIssues`); it never crashes the app.
- Request bodies sent to the control plane are capped at 1 MB.
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
- Redaction runs on the write path, before anything is buffered. JSON is walked structurally, so sensitive keys are removed even when their values look ordinary: credentials and card/bank fields by key substring, and personal-data keys (`msisdn`, phone/mobile numbers, e-mail, date of birth) by whole key, so `mobilePlanName` stays readable. JWTs, bearer tokens, card-like digit runs, IBANs and e-mail addresses are replaced wherever they appear. Add application-specific keys with `redactKeys`.
- Every omission carries a human-readable reason that the extension displays, so a blank payload panel is never ambiguous.

Redaction is a strong default, not a universal PII guarantee. Review captured payloads before attaching them to a defect.

## End-to-end activation

1. Deploy CLEAR-APP with `APILENS_ENABLED=true` and a strong `APILENS_CONTROL_TOKEN` through approved configuration. Do not commit the token or edit tracked env files as a shortcut.
2. Build and load the extension (`pnpm --filter @apilens/browser-extension check`, then load `apps/browser-extension/dist` unpacked).
3. Open DevTools → **ApiLens** → **Settings** → *Instrumented server*. Paste the app origin (or the full `/api/__apilens` mount) and the control token, then use **Test connection** before saving.
4. **Start QA session** in the app's tab. While it records, the extension sends `x-qa-session-id` on every request that tab makes to the app's host, including page loads and server actions. On a shared dev server, **Server API → My session** then shows only your calls; **Everyone** shows all traffic. Turn this off with *Tag my traffic with my QA session* in Settings.
5. Open **Server API**. Use the application; incoming routes and their upstream calls appear within a poll interval, with Payload and Response tabs.
6. Select a call → **Simulate a problem** → choose what should go wrong → **Save and turn on**. Rules created from a call apply to the next matching call only, unless the tester chooses *Every call*.
7. **Traces** correlates server spans with browser requests for the same journey.

For the local agent path instead: run `pnpm --filter @apilens/agent build` and `pnpm agent`, keep `agentToken`, and inspect **Traces** as in 0.1.0. `apiLens.diagnostics` exposes accepted/dropped counts and a non-secret delivery error.

## Runtime footprint

- **Patches.** `install()` wraps `http.Server.prototype.emit`, `https.Server.prototype.emit`, `http(s).request`/`get` (with ESM bindings) and global `fetch`, all inside try/catch that falls back to the original. `shutdown()` restores them unless another library has wrapped them since. With `enabled` false nothing is patched.
- **Memory.** At most `control.bufferSize` calls and `control.maxBufferBytes` bytes (default 500 and 32 MB); each body is capped at `captureBodies.maxBytes`.
- **CPU.** Body copies are taken as bytes move; redaction and decompression run after the response finished, off the event loop where possible.
- **Attribution.** Tracer and telemetry agents and `ignoreOutgoing` hosts pass through untouched (not captured, never mocked). Calls started after the response finished are skipped by default. Both are counted in `diagnostics`.

Telemetry is best-effort, bounded to 1,000 queued spans with batches of 100, a two-second delivery timeout, and observable drop counters. Agent outages do not fail application requests. Flush after in-flight application work settles and then `await apiLens.shutdown()` during graceful termination. Abrupt serverless termination may lose queued spans and in-memory captures; this version targets a long-lived Node server.
