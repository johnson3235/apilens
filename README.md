# ApiLens — QA Network Lab

ApiLens is a local-first QA platform combining browser API inspection, controlled failure simulation, distributed trace correlation, replay, contract checks, deterministic insights and evidence export.

## Visibility boundary

| Traffic | Mechanism |
|---|---|
| Page Fetch/XHR/WebSocket/SSE | Captured directly by extension hooks |
| Browser navigation/assets | Metadata captured with `webRequest` |
| SSR/BFF/Node outgoing calls | Reported by explicit SDK/trace instrumentation |
| SSR/BFF **payloads and responses** | Captured by `@apilens/next-sdk` when `captureBodies` is enabled |
| Remote dev server internals | Read through the SDK's authenticated in-app control plane |
| Controlled server-to-server calls | Routed through the local QA proxy, or short-circuited by server mock rules |
| Uninstrumented remote backend calls | **Not visible** |

ApiLens never claims that a browser extension can observe arbitrary calls inside remote infrastructure. Server-side visibility exists only where the SDK is installed and explicitly enabled.

## Quick start

```powershell
pnpm install
pnpm --filter @apilens/browser-extension check
pnpm brave
```

Open a normal HTTP(S) page, open DevTools → **ApiLens**, follow **Start here**, and run **QA Mocks → Repair & test** before enabling a rule.

New to the tool? Press **How it works** in the header for a fifteen-slide walkthrough explaining every section, how to use it, and its limitations. Any section's **Explain this section** button opens the walkthrough at the relevant slide.

### Finding a call

The **Network** view defaults to API calls only. Search with plain words, or narrow precisely:

```
billing                      match anywhere
"order summary"              exact phrase
-image                       exclude
status:5xx                   status bucket (also 404, >=400)
method:POST,PUT              comma means OR
host:api.vodafone            hostname contains
body:contactId               search payloads
page:/myaccount              only calls from a matching page
mock:yes   error:yes   slow:>1000
```

Press <kbd>/</kbd> to focus the box, <kbd>?</kbd> for the full syntax list. Scope to one page with the **Page** control, then use **Extract** to copy or save the calls you are looking at as cURL, `fetch()`, JSON, CSV, HAR, a URL list or a Markdown table.

Optional local agent:

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

The agent binds to loopback and requires its generated token.

## Workspace

- `apps/browser-extension` — MV3 popup, DevTools, capture, browser mocking and the Server API workspace.
- `apps/agent` — localhost WebSocket/HTTP agent, replay, evidence and controlled proxy.
- `sdks/next` — App Router tracing, payload capture, server mocking and the in-app control plane.
- `sdks/node` — Express middleware and outgoing Node HTTP tracing.
- `packages/*` — tracing, mocking, replay, security, evidence, insights, contracts and diff engines.
- `examples/*` — local demonstration applications.

## Documentation

- [CLEAR-APP frontend SDK setup guide](docs/frontend-sdk-setup.md)
- [Claude implementation prompt for CLEAR-APP](docs/claude-clear-app-sdk-prompt.md)
- [Next.js server SDK API and coverage](sdks/next/README.md)
- [Technical assessment](docs/technical-assessment.md)
- [Architecture](docs/architecture.md)
- [Extension](docs/extension.md)
- [Local agent](docs/local-agent.md)
- [Tracing](docs/tracing.md)
- [Mocking](docs/mocking.md)
- [Security](docs/security.md)
- [Playwright integration](docs/playwright-integration.md)
- [Troubleshooting](docs/troubleshooting.md)

## Validation

```powershell
pnpm -r --if-present run typecheck
pnpm -r --if-present run test
pnpm --filter @apilens/agent test:integration
pnpm --filter @apilens/browser-extension check
pnpm build
```

An optional [end-to-end test](apps/browser-extension/e2e/README.md) drives the built
extension in a real Chromium browser, covering capture, redaction, filtering, mocking
and evidence export against the shipped artefact.

## Knowledge transfer

[ApiLens-Testing-Guild-KT.pptx](docs/ApiLens-Testing-Guild-KT.pptx) is a 20-slide deck
with full speaker notes, covering the problem, the capabilities, the visibility
boundary, safety guardrails, a live-demo script and a rollout plan.
