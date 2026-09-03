# Local QA Agent

The agent is the trusted local boundary for server telemetry, controlled proxying, replay, evidence and automation.

```powershell
pnpm --filter @apilens/agent build
pnpm agent
```

Defaults are loopback-only. A generated token is required for captured-data HTTP and WebSocket operations. Non-loopback binding is rejected unless `APILENS_ALLOW_REMOTE=1` is deliberately set.

Start a controlled proxy with `--proxy 8081:https://payments.qa.internal:qa`, then explicitly route the controlled SSR/BFF dependency through it. This is not transparent infrastructure interception.

`GET /health` exposes version/protocol/counts but no captured data. Other HTTP routes require `Authorization: Bearer <token>`.
