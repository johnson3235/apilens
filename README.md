# ApiLens — QA Network Lab

ApiLens is a local-first QA platform combining browser API inspection, controlled failure simulation, distributed trace correlation, replay, contract checks, deterministic insights and evidence export.

## Visibility boundary

| Traffic | Mechanism |
|---|---|
| Page Fetch/XHR/WebSocket/SSE | Captured directly by extension hooks |
| Browser navigation/assets | Metadata captured with `webRequest` |
| SSR/BFF/Node outgoing calls | Reported by explicit SDK/trace instrumentation |
| Controlled server-to-server calls | Routed through the local QA proxy |
| Uninstrumented remote backend calls | **Not visible** |

ApiLens never claims that a browser extension can observe arbitrary calls inside remote infrastructure.

## Quick start

```powershell
pnpm install
pnpm --filter @apilens/browser-extension check
pnpm brave
```

Open a normal HTTP(S) page, open DevTools → **ApiLens**, follow **Start here**, and run **QA Mocks → Repair & test** before enabling a rule.

Optional local agent:

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

The agent binds to loopback and requires its generated token.

## Workspace

- `apps/browser-extension` — MV3 popup, DevTools, capture and browser mocking.
- `apps/agent` — localhost WebSocket/HTTP agent, replay, evidence and controlled proxy.
- `sdks/node` — Express middleware and outgoing Node HTTP tracing.
- `packages/*` — tracing, mocking, replay, security, evidence, insights, contracts and diff engines.
- `examples/*` — local demonstration applications.

## Documentation

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
