# Browser Extension

ApiLens is a Chromium Manifest V3 extension with a toolbar popup and DevTools panel.

- MAIN-world hooks wrap Fetch, XHR, beacon, WebSocket and EventSource.
- An isolated bridge validates and forwards messages.
- `webRequest` adds navigation/resource metadata.
- Captures are redacted before storage, broadcast or export.

## Workflow

1. Load `apps/browser-extension/dist` unpacked.
2. Open a normal HTTP(S) page and reload once.
3. Open DevTools → **ApiLens**. The first run opens **Start here** and the walkthrough.
4. Press **Record session** in the header and perform one journey.
5. Read **Server calls** and **Browser calls**; open **Traces** to see them joined.
6. Break a call with **Simulate a problem** (server) or **Mock this** (browser), then repeat the step. For browser mocks, run **Mocks → Repair & test** first.
7. Stop the session, turn the mocks off (**Mocks → Turn all off**) and export evidence.

### Layout (1.5.0)

- **Header:** the environment, a status chip each for the browser hooks and the linked server (with the number of pods when there are several), a chip while any mock is on, **Record session** with a running timer, and **?** for help.
- **Sidebar:** *Test* (Server calls, Browser calls, Mocks, Evidence, Traces) and *Set up* (Connect an app, Settings). Below 1000 px wide it collapses to icons with counts.
- **Help (?):** *Explain this screen* opens the fifteen-slide walkthrough at the slide for the current screen; *Guided tour*, *Start here* and the *How-to library* live there too. The walkthrough is a modal dialog with a focus trap, arrow-key navigation, and Escape to close.
- Light and dark themes are under **Settings → Appearance**. In Server calls, `/` focuses the filter and Escape closes the detail.

Restricted browser pages cannot be injected. Page hooks cannot modify service-worker/browser-internal traffic.

## Browser calls

The **Browser calls** view is the browser-side workspace: find a call, read it, break it, extract it.

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

**Mock this** on a selected call opens the rule editor pre-filled from the real request. Eighteen presets cover service failures, authentication, latency, network conditions and payload defects. Rules are created **disabled** and scoped to the captured path; widening the pattern is a deliberate act. Turn one on under **Mocks**, then repeat the journey.

Columns drop by priority as the panel narrows, so a docked DevTools pane stays readable instead of truncating every cell.

## Server calls

The **Server calls** view shows what the application does *after* the browser request ends. Each page (or route, or server action) is a group: the Edge middleware run that let it through and the calls that run made, then the backend calls the page made, each tagged **Page**, **Middleware**, **Backend** or **Cache** (answered by Next's fetch cache, no backend call). A timeline bar shows where each call sat inside its page's time, so the call that held the page up is visible at a glance. Filter chips count **Failed**, **Slow**, **Mocked** and **Cached** calls; a matching backend call keeps its page around it. Click a call for what was sent, what came back, headers and correlation IDs; **Simulate a problem** opens the mock editor in place.

When the list is empty while the server is connected, the view shows the server's own diagnosis from SDK 0.5.0: whether capture is installed, how many requests reached it, and how many were skipped and why (ignored path, no QA session, an origin outside `allowedAppOrigins`, no backend call), each with the config line to copy for the app's developer. With calls listed, a warning chip in the header opens the same card.

It requires an application running [`@apilens/next-sdk`](../sdks/next/README.md) 0.3.0 or later with its control plane enabled (0.4.0 also reports Edge middleware calls, memory use and configuration issues; 0.5.0 adds the capture diagnosis, middleware nesting, cache hits and per-pod cursors). Configure the endpoint and token under **Settings → Instrumented server**, and use **Test connection** before saving — a wrong URL or token is the usual reason server capture appears to do nothing, and from SDK 0.4.0 the result also lists any setting the server switched off at boot.

- **Shared servers.** While a QA session records, the extension tags every request the recording tab sends to the app's host (page loads, RSC, server actions and fetch) with `x-qa-session-id`, through a session-scoped `declarativeNetRequest` rule limited to that tab and that host. The view then defaults to **My session**, showing only this tester's calls; **Everyone** shows all traffic. The rule is removed when the session stops. Turn it off with *Tag my traffic with my QA session* in Settings.

- Polling is driven by the panel, not the service worker, because an MV3 worker is evicted after about 30 seconds of inactivity. Requests are issued from the worker, which holds host permissions and is therefore not subject to page CORS.
- Each poll sends one `seq` cursor per server process, so only new calls cross the wire. Behind a load balancer any pod may answer a poll: each reads its own cursor, calls are merged by span id, and the header shows how many pods answered. A restarted pod is simply a new process. A mock saved to one pod is re-applied to pods that did not receive it, unless one of them holds a later edit.
- Captured calls also become spans, so **Traces** correlates them with browser requests from the same journey.

### Server mocks

Selecting a call and choosing **Simulate a problem** opens a three-step editor: which call, what should go wrong (plain-language scenarios that each say what to check on the page), and how many times. The rule is scoped to that path and defaults to **only the next call**, because dev servers are shared; **Save and turn on** applies it, **Save, keep off** stores it disabled, and **Turn all off** disables every rule at once. Technical fields (match type, status code, latency, headers, priority) are under **Developer options**. Presets cover 503, 401, 429, added latency, connection failure, timeout, truncated JSON and empty responses; `passthrough-mutate` calls the real upstream and then edits fields in its JSON response.

The **Mocks** screen lists browser and server mocks side by side, with one **Turn all off**; the header shows a chip while any mock is on. Rules are stored in the server process and disappear when it restarts. They run between the route handler and its upstream services, which is the only place a browser mock cannot reach. Never target an endpoint with real financial or order side effects.

### What it does not do

Payloads are bounded by `captureBodies.maxBytes` and redacted on the server before capture, so truncated and redacted content is labelled rather than silently altered. Binary responses are skipped with a stated reason. The view shows only what an instrumented, explicitly enabled SDK reports — never arbitrary traffic inside remote infrastructure.
