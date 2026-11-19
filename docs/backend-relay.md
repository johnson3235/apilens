# Backend relay: see and mock what JCS calls (TMF, OSB, Vesta)

The Next SDK shows what the CLEAR BFF does: the page, and the calls it makes to JCS. What JCS
does next (its calls to the TMF services, and theirs to OSB or Vesta) happens inside other
services, which ApiLens cannot see from the BFF.

The **ApiLens relay** is a small forwarding proxy that sits between a JCS service (such as
`bill-analysis-js`) and the services it calls. Its base URLs for those services point at the relay
instead; the relay forwards every request unchanged. For a tester's own requests it also records
the call and, when asked, answers it from a mock. In the extension, under **Server calls**:

```
Page   GET  /myaccount/bills
└ Backend GET bill-analysis.dev/bills          ← the BFF's call to JCS (Next SDK)
  ├ TMF678 GET  /tmf-api/customerBillManagement/v4/customerBill   ← seen by the relay
  └ TMF677 GET  /tmf-api/usageManagement/v4/usage
```

Each row opens like any other call: the request and response bodies, headers, timing, and
**Simulate a problem** to change the answer of that one TMF call.

Configuration only, in JCS: no code change. The frontend and the BFF are not touched.

## Safety on a shared environment

Every squad's JCS → TMF traffic goes through the relay, so it is built to be invisible to anyone
not testing with ApiLens:

| Traffic | What the relay does |
|---|---|
| Not a tester's (other squads, batch jobs, health checks) | Streamed straight through. Not buffered, not recorded, never mocked. |
| A tester's request | Forwarded unchanged and recorded, with bodies redacted before they leave the relay. |
| A mock a tester saved from a relay call | Applies **only to that tester's QA session** by default ("Only my QA session" in the editor). A rule never applies to traffic that is not a tester's, even if someone unticks that box. |

It never adds, removes or rewrites a header on the way to the TMF, apart from what any proxy
must: `Host` becomes the TMF's, and connection-level headers (`Connection`, `Transfer-Encoding`,
`Content-Length` framing) are recomputed. Compressed answers are passed through compressed. If
the relay cannot reach a service it answers `502` with `x-apilens-relay: upstream-unreachable`,
and a body naming the host, so it is never mistaken for a TMF error.

**Rollback** is the reverse config change: point JCS's URLs back at the TMF hosts.

## How a tester's calls are recognised

The BFF sends `x-qa-session-id`, `traceparent` and `baggage` to JCS (Next SDK, for origins in
`propagateToOrigins`). The relay recognises a tester's call in either of two ways, and one is
enough:

1. **By trace (SDK 0.7.0+, usually nothing to do).** If JCS continues the BFF's trace, as
   Datadog, OpenTelemetry and Brave do, its calls to the TMFs carry the same trace id. The SDK
   remembers which tester each trace belongs to; the relay asks the app and treats the call as
   that tester's. It reads `traceparent`, B3 and Datadog's `x-datadog-trace-id`.
2. **By header.** JCS passes `x-qa-session-id` (or W3C `baggage`) on.

To check (1) without the relay: in Datadog APM, open the trace of a page request. If the BFF,
JCS and the TMF calls are in the **same trace**, it will work. If JCS starts a new trace, one of
these is needed (dev only):

```bash
# Datadog agent, any stack (Quarkus, Spring…): continue W3C traces as well as Datadog's own
DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext
```

```yaml
# Spring Boot 3 (micrometer-tracing), application-dev.yml
management:
  tracing:
    propagation:
      consume: w3c, b3
    baggage:
      remote-fields: x-qa-session-id, x-test-scenario-id
```

```properties
# Quarkus REST Client with the default headers factory (not a custom ClientHeadersFactory)
org.eclipse.microprofile.rest.client.propagateHeaders=x-qa-session-id,x-test-scenario-id,traceparent
```

**What trace lookups cost other squads.** Nothing while no one is testing: the relay only asks
while a tester is active (an extension connected to the app, or a tester's trace in the last
15 minutes). Then it asks once per unknown trace, at most 20 times a second, and waits at most
300 ms (`APILENS_RELAY_ATTRIBUTION_TIMEOUT_MS`) before passing the call through as usual. Most of a
tester's own traces reach the relay ahead of their calls, with the rules it polls every 2 s.

If the CLEAR app runs several replicas, a lookup can reach one that did not handle the tester's
request. That call is passed through unrecorded; the next ones of the same trace are recognised
within 2 s, once the relay has polled the other replica. Header propagation (2) has no such gap.

## Deploy

### 1. The relay

A ready image is published with each release:
`ghcr.io/johnson3235/apilens-relay:0.7.0` (amd64 and arm64). If the cluster only pulls from your
own registry, copy it there (no Docker build needed):

```bash
crane copy ghcr.io/johnson3235/apilens-relay:0.7.0 <account>.dkr.ecr.<region>.amazonaws.com/apilens-relay:0.7.0
```

**With Argo CD / Helm** (recommended): the chart is `oci://ghcr.io/johnson3235/charts/apilens-relay`,
version `0.7.0` (source in [`infrastructure/relay/chart`](../infrastructure/relay/chart)). Values for
one JCS service:

```yaml
name: apilens-relay-bill-analysis
caller: bill-analysis-js
routes:                     # route name → the address the service calls today
  tmf678: http://customer-bill-management-fs-quarkus:8080
  tmf677: http://query-usage-consumption-fs:8080
control:
  url: https://<clear-dev>/api/__apilens
  existingSecret: apilens-relay-token     # a Secret with key APILENS_CONTROL_TOKEN
# image.repository: <your registry>/apilens-relay   if you copied the image
```

The Secret holds the same value as `APILENS_CONTROL_TOKEN` in the CLEAR app. Create it outside
Git (or with your sealed-secrets / external-secrets setup):

```bash
kubectl -n <namespace> create secret generic apilens-relay-token --from-literal=APILENS_CONTROL_TOKEN='<token>'
```

The chart runs two replicas spread across nodes, a PodDisruptionBudget, probes, resource limits,
and a restricted security context (non-root uid 1000, read-only filesystem, no capabilities,
seccomp `RuntimeDefault`), which the usual Kyverno / Pod Security policies accept. No Ingress.

**Without Helm:** [`infrastructure/relay/k8s.yaml`](../infrastructure/relay/k8s.yaml) is the same as
plain manifests.

**Check it** before touching JCS:

```bash
kubectl -n <namespace> port-forward svc/apilens-relay-bill-analysis 8080:8080
curl localhost:8080/__relay/health                     # 200 with the route names
curl localhost:8080/tmf678/<a path JCS calls>          # the same answer as the TMF directly
```

The relay must reach the CLEAR app's URL from the cluster (egress HTTPS). Its logs say so if it
cannot: `control plane rules: fetch failed`, or `HTTP 401 (APILENS_CONTROL_TOKEN does not match
the app)`.

### 2. Point JCS at it (dev config only)

For each service, keep the path and prefix the route name. The host is the relay's Service (the
Helm release name):

```properties
# before (the property name is whatever the service uses today)
quarkus.rest-client.tmf678.url=http://customer-bill-management-fs-quarkus:8080
# after
quarkus.rest-client.tmf678.url=http://apilens-relay-bill-analysis:8080/tmf678
```

Everything after `/tmf678` is appended to the route's target, query string included. Restart JCS
and compare one normal call with the answer before.

### 3. OSB and Vesta (optional)

Point the TMF services' OSB/Vesta URLs at `/osb` and `/vesta` on a relay in the same way, with
`callers: { osb: tmf, vesta: tmf }`, so those calls nest under the TMF call that made them.

### 4. Use it

Open the app with the extension, start a QA session, and use the journey. When the backend drops
the session header, connect the extension (open **Server calls**) a couple of seconds before the
journey: until a tester is connected the relay does not look traces up, so the very first calls
would pass through unrecorded. **Server calls** shows
the TMF rows. The capture checklist (the status line at the top) reports the relay: calls
recorded and how they were recognised, or why there are none.

## Settings

Environment variables of the relay (the chart sets them from its values):

| Variable | Default | Meaning |
|---|---|---|
| `APILENS_RELAY_ROUTES` | — (required) | `name=url` pairs, comma or newline separated. `name` is the first path segment JCS calls and the label in the extension. |
| `APILENS_CONTROL_URL` | — (required) | The app's control plane, e.g. `https://clear-dev.example.com/api/__apilens`. |
| `APILENS_CONTROL_TOKEN` | — (required) | The app's control token. |
| `APILENS_RELAY_CALLER` | `backend` | Who calls the routes, shown on each row (`bill-analysis-js`). |
| `APILENS_RELAY_CALLERS` | — | Per-route caller, `osb=tmf,vesta=tmf`, for routes another layer calls. |
| `APILENS_RELAY_NAME` | `apilens-relay` | Name in the extension's checklist. |
| `APILENS_RELAY_SHARED` | `true` | `false` records traffic that is not a tester's too (under the shared session). Only on an environment no one else uses. |
| `APILENS_RELAY_ATTRIBUTION_TIMEOUT_MS` | `300` | Longest wait for the app to say whose trace a call is, before passing it through. |
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
| No relay line at all | The relay cannot reach the app, or the token differs. | Relay logs say which: `control plane ingest: HTTP 401 (APILENS_CONTROL_TOKEN does not match the app)`, or a network error (egress policy?). |
| "Relay … is up, but nothing went through it yet" | JCS still calls the TMF hosts directly. | Check JCS's dev config (step 2) and restart JCS. |
| "N calls went through relay …, none of them from a QA session" | JCS neither continues the BFF's trace nor passes the session on. | One of the settings under [How a tester's calls are recognised](#how-a-testers-calls-are-recognised). Check that the BFF's `propagateToOrigins` includes the address it calls JCS on. |
| TMF rows at the top, not under the page | Recognised by header, but JCS starts a new trace. | `DD_TRACE_PROPAGATION_STYLE=datadog,tracecontext`, or the Spring `consume: w3c, b3`. |
| Relay answers `502` with `x-apilens-relay: no-route` | The path's first segment is not a configured route. | Add it to the routes. |
| "Relay … dropped N calls" | The app was unreachable for a while; captures queued past 1000 were dropped. | Only the recording was lost; the calls went through. |
