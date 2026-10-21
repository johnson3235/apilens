# Setup

## Prerequisites

- Node.js 20+
- pnpm 9+
- Brave, Chrome or Edge 116+

## Install and validate

```powershell
pnpm install
pnpm --filter @apilens/browser-extension check
```

## Launch in an isolated Brave profile

```powershell
pnpm brave
```

The unpacked extension is built at `apps/browser-extension/dist`. The isolated profile is `.brave-extension-profile` and does not modify the normal browser profile.

For Chrome/Edge, enable Developer mode on the extensions page and load `apps/browser-extension/dist`. After rebuilding, click **Reload** on the extension card and reload the target page once.

## First QA session

1. Open a normal HTTP(S) target page.
2. Open DevTools → **ApiLens** → **Start here**.
3. Click **Start QA session** and perform one customer journey.
4. Select a request in Network to inspect it.
5. Before mocking, open **QA Mocks** and run **Repair & test**.
6. Stop recording and export evidence.

## Optional local agent

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

Copy the printed token into ApiLens Settings and connect. The agent binds to `127.0.0.1:7317` by default. It is required for instrumented server spans, controlled proxying, agent replay, filesystem evidence and future automation integrations.

## Demo applications

```powershell
pnpm --filter @apilens/demo-api-server dev
pnpm --filter @apilens/demo-nextjs-app dev
```

Open `http://localhost:3000`, then record the checkout journey.

The Next demo is instrumented with the [Next SDK](../sdks/next/README.md): its `app/api` routes are wrapped, so each incoming route and the upstream calls it makes to the demo API appear in **Server API**. Start it with the control plane on:

```powershell
$env:APILENS_ENABLED = 'true'
$env:APILENS_CONTROL_TOKEN = 'demo-control-token-0123456789abcdef'  # any local value of 24+ characters
pnpm --filter @apilens/demo-nextjs-app dev
```

In **Settings → Instrumented server**, enter `http://localhost:3000` and the same token. `apps/browser-extension/e2e/server.e2e.mjs` drives this journey end to end, including a server mock on the payment call.

For CLEAR-APP, use the [browser-only QA runbook](clear-app-qa-setup.md). No SDK or agent is required for browser capture.

See [troubleshooting.md](troubleshooting.md) for worker, engine and agent diagnostics.
