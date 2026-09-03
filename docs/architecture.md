# Architecture

```mermaid
flowchart TD
  PAGE[Customer page] --> HOOK[MAIN-world hooks]
  HOOK <--> BRIDGE[Isolated bridge]
  BRIDGE <--> SW[MV3 service worker]
  SW <--> IDB[(IndexedDB)]
  SW <--> PANEL[ApiLens DevTools]
  SW <--> AGENT[Local QA Agent]
  NODE[Node SDK / OTel] --> AGENT
  SSR[SSR / BFF] --> PROXY[Controlled QA Proxy] --> API[Downstream API]
  PROXY --> AGENT
```

The extension directly observes only browser-visible traffic. Server telemetry comes from explicit instrumentation or the controlled proxy and retains its provenance. Uninstrumented server calls remain invisible.

Shared domain packages contain parsing, trace, mock, replay, diff, contract, security, insight and evidence logic. Browser and agent applications adapt them to Chrome APIs, IndexedDB, WebSocket, HTTP and filesystem boundaries.

The MV3 worker registers listeners synchronously and restores state through an initialization promise. Content hooks report a fingerprinted rule revision. Repair reinstalls hooks, synchronizes rules, and runs a synthetic request that must never reach the network.
