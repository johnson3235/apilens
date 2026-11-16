# Backend relay: see and mock what JCS calls (TMF, OSB, Vesta)

The Next SDK shows what the CLEAR BFF does: the page, and the calls it makes to JCS. What JCS
does next (its calls to the TMF services, and theirs to OSB or Vesta) happens inside other
services, which ApiLens cannot see from the BFF.

The **ApiLens relay** is a small forwarding proxy that sits between JCS and those services.
JCS's TMF base URLs point at the relay instead of the TMF hosts; the relay forwards every
request unchanged. For a tester's own requests it also records the call and, when asked, answers
it from a mock. In the extension, under **Server calls**:

```
Page   GET  /myaccount/orders
└ Backend POST jcs.dev/orders                 ← the BFF's call to JCS (Next SDK)
  ├ TMF629 GET  /tmf-api/customerManagement/v4/customer/42      ← seen by the relay
  └ TMF622 POST /tmf-api/productOrdering/v4/productOrder
    └ OSB  POST /osb/v1/provisioning           ← the TMF's call, also through the relay
```

Each row opens like any other call: what was sent, what came back, headers, timing, and
**Simulate a problem** to change the answer of that one TMF call.

No code changes in JCS or the TMFs: configuration only. The frontend and the BFF are not touched.

## Safety on a shared environment

Every squad's JCS → TMF traffic goes through the relay, so it is built to be invisible to anyone
not testing with ApiLens:

| Traffic | What the relay does |
|---|---|
| No QA session (other squads, batch jobs, health checks) | Streamed straight through. Not buffered, not recorded, never mocked. |
| A tester's request (carries `x-qa-session-id`) | Forwarded unchanged and recorded, with bodies redacted before they leave the relay. |
| A mock a tester saved from a relay call | Applies **only to that tester's QA session** by default ("Only my QA session" in the editor). A rule never applies to traffic without a QA session, even if someone unticks that box. |

It never adds, removes or rewrites a header on the way to the TMF, apart from what any proxy
must: `Host` becomes the TMF's, and connection-level headers (`Connection`, `Transfer-Encoding`,
`Content-Length` framing) are recomputed. Compressed answers are passed through
compressed. If the relay cannot reach a service it answers `502` with
`x-apilens-relay: upstream-unreachable`, and a body naming the host, so it is never mistaken for a
TMF error.

**Rollback** is the reverse config change: point JCS's URLs back at the TMF hosts.

## How a tester's calls are recognised

The BFF already sends `x-qa-session-id` and `traceparent` to JCS (Next SDK, for origins in
`propagateToOrigins`), and from SDK 0.6 also W3C `baggage: x-qa-session-id=…`. JCS has to pass
them on to the TMFs. With Spring Boot 3 that is configuration:

```yaml
# JCS application-dev.yml (Spring Boot 3, micrometer-tracing)
management:
  tracing:
    baggage:
      remote-fields: x-qa-session-id, x-test-scenario-id
```

That needs, as most Spring Boot 3 services already have:

- `spring-boot-starter-actuator` and a tracing bridge (`micrometer-tracing-bridge-brave` or
  `micrometer-tracing-bridge-otel`).
- HTTP clients created from Spring's builders (`RestTemplateBuilder`, `WebClient.Builder`,
  `RestClient.Builder`, or OpenFeign with Micrometer), so they carry the trace. A client made with
  `new RestTemplate()` does not.

With the OpenTelemetry Java agent instead, nothing is needed: it passes W3C baggage on by default,
and the relay reads the session from it.

Trace headers: the relay reads `traceparent`, and B3 (`b3`, `X-B3-TraceId`) for services that
send only B3. If JCS does not continue the BFF's trace, TMF calls still appear (with the tester's
session), but at the top of the list instead of under the page.

The TMF services need the same `remote-fields` setting for their OSB and Vesta calls to be
recognised.

## Deploy

1. **Build the image** from the SDK release (the relay ships inside `@apilens/next-sdk` 0.6.0+):

   ```bash
   cd infrastructure/relay
   curl -LO https://github.com/johnson3235/apilens/releases/download/next-sdk-v0.6.0/apilens-next-sdk-0.6.0.tgz
   docker build -t <your-registry>/apilens-relay:0.6.0 .
   ```

2. **Deploy it** in the dev namespace with [`infrastructure/relay/k8s.yaml`](../infrastructure/relay/k8s.yaml):
   fill in the routes (each TMF's current address), the CLEAR app address and the control token
   (the same `APILENS_CONTROL_TOKEN` the app uses). Keep it in-cluster: no Ingress.

3. **Point JCS at it** (dev profile only). For each TMF, prefix the route name:

   ```yaml
   # before
   tmf.product-ordering.base-url: https://tmf622.dev.internal/tmf-api/productOrdering/v4
   # after
   tmf.product-ordering.base-url: http://apilens-relay:8080/tmf622/tmf-api/productOrdering/v4
   ```

   Everything after `/tmf622` is appended to the route's target, query string included.

4. **Optional, OSB and Vesta**: point the TMF services' OSB/Vesta URLs at `/osb` and `/vesta` on
   the relay in the same way, and keep `APILENS_RELAY_CALLERS=osb=tmf,vesta=tmf` so those calls
   nest under the TMF call that made them.

5. Open the app with the extension, start a QA session, and use it. **Server calls** shows the TMF
   rows. The capture checklist (the status line at the top) reports the relay: calls recorded,
   or why there are none.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `APILENS_RELAY_ROUTES` | — (required) | `name=url` pairs, comma or newline separated. `name` is the first path segment JCS calls and the label in the extension. |
| `APILENS_CONTROL_URL` | — (required) | The app's control plane, e.g. `https://clear-dev.example.com/api/__apilens`. |
| `APILENS_CONTROL_TOKEN` | — (required) | The app's control token. |
| `APILENS_RELAY_CALLER` | `backend` | Who calls the routes, shown on each row (`jcs`). |
| `APILENS_RELAY_CALLERS` | — | Per-route caller, `osb=tmf,vesta=tmf`, for routes another layer calls. |
| `APILENS_RELAY_NAME` | `apilens-relay` | Name in the extension's checklist. |
| `APILENS_RELAY_SHARED` | `true` | `false` records traffic without a QA session too (under the shared session). Only on an environment no one else uses. |
| `APILENS_RELAY_MAX_BODY_BYTES` | `131072` | Largest payload captured per call (the call itself is never cut). |
| `APILENS_RELAY_MAX_REQUEST_BYTES` | `8388608` | Largest tester request held for mock matching; larger ones are forwarded and recorded without bodies. |
| `APILENS_RELAY_REDACT_KEYS` | — | Extra JSON keys to redact, comma separated, on top of the SDK's list (passwords, tokens, card numbers, MSISDN, e-mail…). |
| `PORT` | `8080` | Listen port. |
| `NODE_EXTRA_CA_CERTS` | — | Internal CA bundle for `https` upstreams. |

`GET /__relay/health` (and `/__relay/ready`) answer `200` with the route names, for probes. They
never return traffic.

## Troubleshooting

| The checklist says | Cause | Fix |
|---|---|---|
| No relay line at all | The relay cannot reach the app, or the token differs. | Relay logs say which: `control plane ingest: HTTP 401 (APILENS_CONTROL_TOKEN does not match the app)`, or a network error. |
| "Relay … is up, but nothing went through it yet" | JCS still calls the TMF hosts directly. | Check JCS's dev config (step 3) and restart JCS. |
| "N calls went through relay …, none of them from a QA session" | JCS does not pass `x-qa-session-id` on. | The Spring config above. |
| TMF rows at the top, not under the page | JCS starts a new trace instead of continuing the BFF's. | Spring Boot 3 reads W3C `traceparent` by default; if JCS is set to B3 only, add `management.tracing.propagation.consume: w3c, b3`. |
| Relay answers `502` with `x-apilens-relay: no-route` | The path's first segment is not a configured route. | Add it to `APILENS_RELAY_ROUTES`. |
| "Relay … dropped N calls" | The app was unreachable for a while; captures queued past 1000 were dropped. | Only the recording was lost; the calls went through. |
