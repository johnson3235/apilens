# Browser Extension

ApiLens is a Chromium Manifest V3 extension with a toolbar popup and DevTools panel.

- MAIN-world hooks wrap Fetch, XHR, beacon, WebSocket and EventSource.
- An isolated bridge validates and forwards messages.
- `webRequest` adds navigation/resource metadata.
- Captures are redacted before storage, broadcast or export.

## Workflow

1. Load `apps/browser-extension/dist` unpacked.
2. Open a normal HTTP(S) page and reload once.
3. Open DevTools → **ApiLens** → **Start here**.
4. Start a QA session and perform one journey.
5. Inspect provenance-labelled requests and traces.
6. Run **QA Mocks → Repair & test** before mocking.
7. Stop the session and export evidence.

Restricted browser pages cannot be injected. Page hooks cannot modify service-worker/browser-internal traffic.
