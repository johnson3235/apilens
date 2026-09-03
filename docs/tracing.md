# Distributed Tracing

ApiLens correlates `traceparent`, `tracestate`, `x-request-id`, `x-correlation-id`, `request-id`, and B3 identifiers. Custom headers are configurable.

```mermaid
sequenceDiagram
  Browser->>SSR/BFF: request + trace context
  SSR/BFF->>Downstream: child trace context
  SSR/BFF-->>QA Agent: sanitized spans
  Browser-->>QA Agent: browser request/span
  QA Agent-->>Browser: correlated trace update
```

Install Node middleware before application routes and enable outgoing interception only in controlled QA execution. Prefer W3C/OpenTelemetry context. A missing instrumented hop appears as a gap; ApiLens does not invent it.
