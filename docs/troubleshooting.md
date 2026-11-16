# Troubleshooting

## Service worker registration

Run `pnpm --filter @apilens/browser-extension check`, then reload the unpacked extension. The verifier rejects forbidden top-level worker initialization.

## Mock Engine

Open a normal HTTP(S) tab, reload once, keep it selected, and choose **Mocks → Repair & test**. Engine Doctor separates page support, environment policy, hooks, rule synchronization and self-test. Internal/store pages cannot be injected.

## Missing server trace

The browser cannot observe remote internal calls. Connect the agent and instrument SSR/BFF with the Node SDK/OpenTelemetry, or route the controlled dependency through the QA proxy.

For calls a backend such as JCS makes to TMF, OSB or Vesta, deploy the [backend relay](backend-relay.md) and point the backend's base URLs at it; its checklist line in **Server calls** says what is missing when those calls do not appear.

## Agent unavailable

Check `GET http://127.0.0.1:7317/health`, match the token in settings, and verify protocol versions. The agent intentionally refuses non-loopback binding.
