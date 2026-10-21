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

New users should take the **How it works** walkthrough in the header: fifteen slides covering every section, what it is, how to use it and its honest limitation. Each sidebar section also has an **Explain this section** button that opens the walkthrough at the matching slide. It is a modal dialog with a focus trap, arrow-key navigation, and Escape to close.

Restricted browser pages cannot be injected. Page hooks cannot modify service-worker/browser-internal traffic.

## Network view

The **Network** view is the browser-side workspace: find a call, read it, break it, extract it.

### Filtering

| Control | Purpose |
|---|---|
| Search box | Plain words plus an optional field syntax |
| **Show** | API calls (default), Pages, Assets or Everything |
| **Outcome** | Any, Failed, Mocked, Slow or Pending |
| **Page** | All pages, This page, or one specific page |

The search box accepts plain words (combined with AND), quoted phrases, `-exclusions`, and field terms such as `status:5xx`, `method:POST,PUT`, `host:api.vodafone`, `path:/v2/billing`, `type:xhr`, `body:contactId`, `header:authorization`, `query:contactId=3055861`, `mock:yes`, `error:yes`, `slow:>1000` and `trace:4bf92f`. A comma inside one term means OR. Press <kbd>/</kbd> anywhere to focus the box and <kbd>Escape</kbd> to clear it; the <kbd>?</kbd> button lists every form, and clicking an example inserts it. Active terms appear as chips that remove themselves when clicked.

Static assets are hidden by default because this is an API tool. When a filter empties the list, the view names the filter responsible, reports how many calls each one removed, and offers a one-click undo — "no results" is never a dead end.

### Page grouping

Every captured call records the page it came from, including `webRequest` observations which carry no page context of their own. Pages are keyed by origin and path, so a query string does not split one screen into many groups. The dropdown lists each page with its call and failure counts.

### Inspecting and extracting

Selecting a row opens the full detail: summary with failure analysis, request and response payloads, trace identity, assertion/contract results, and generated code. **Extract** exports the calls currently shown — cURL, `fetch()` snippets, JSON, CSV, HAR 1.2, a URL list or a Markdown table — either copied to the clipboard or saved to a file. Redaction already applied at capture time is preserved in every format.

### Mocking a browser call

**Mock this** on a selected call opens the rule editor pre-filled from the real request. Eighteen presets cover service failures, authentication, latency, network conditions and payload defects. Rules are created **disabled** and scoped to the captured path; widening the pattern is a deliberate act. Enable one from **QA Mocks**, then repeat the journey.

Columns drop by priority as the panel narrows, so a docked DevTools pane stays readable instead of truncating every cell.

## Server API workspace

The **Server API** view shows what the application does *after* the browser request ends: wrapped App Router handlers and the upstream calls they make, each with request payload, response payload, headers, timing and correlation IDs.

It requires an application running [`@apilens/next-sdk`](../sdks/next/README.md) 0.2.0 with its control plane enabled. Configure the endpoint and token under **Settings → Instrumented server**, and use **Test connection** before saving — a wrong URL or token is the usual reason server capture appears to do nothing.

- Polling is driven by the panel, not the service worker, because an MV3 worker is evicted after about 30 seconds of inactivity. Requests are issued from the worker, which holds host permissions and is therefore not subject to page CORS.
- Each poll uses a `seq` cursor, so only new calls cross the wire. A restarted server changes its process id and the view resets rather than showing stale data.
- Captured calls also become spans, so **Traces** correlates them with browser requests from the same journey.

### Server mocks

Selecting a call and choosing **Simulate a problem** opens a three-step editor: which call, what should go wrong (plain-language scenarios that each say what to check on the page), and how many times. The rule is scoped to that path and defaults to **only the next call**, because dev servers are shared; **Save and turn on** applies it, **Save, keep off** stores it disabled, and **Turn all off** disables every rule at once. Technical fields (match type, status code, latency, headers, priority) are under **Developer options**. Presets cover 503, 401, 429, added latency, connection failure, timeout, truncated JSON and empty responses; `passthrough-mutate` calls the real upstream and then edits fields in its JSON response.

Rules are stored in the server process and disappear when it restarts. They run between the route handler and its upstream services, which is the only place a browser mock cannot reach. Never target an endpoint with real financial or order side effects.

### What it does not do

Payloads are bounded by `captureBodies.maxBytes` and redacted on the server before capture, so truncated and redacted content is labelled rather than silently altered. Binary responses are skipped with a stated reason. The view shows only what an instrumented, explicitly enabled SDK reports — never arbitrary traffic inside remote infrastructure.
