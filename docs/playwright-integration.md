# Playwright Integration

The implemented integration boundary is the authenticated local-agent protocol. A dedicated Playwright fixture/reporter package is planned but not yet shipped.

Today automation can start an agent/session, propagate session and W3C trace context, push markers/spans, and export evidence. The planned reporter will map Playwright test/step IDs, screenshots, video references and failures to session markers without secrets.

Until that package exists, do not claim automatic Playwright attachment or live reporter support.
