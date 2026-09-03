# QA Mocking

## Browser

1. Capture the exact endpoint.
2. Create a narrow method/URL rule.
3. Run **Repair & test** until Engine Doctor passes.
4. Enable the rule and repeat the action.
5. Verify the mocked badge and marker headers.

Actions include status/body/header replacement, delay, timeout, connection/DNS failure, offline, invalid/empty JSON, field mutation, rate limit, auth expiry, WebSocket disconnect and SSE interruption.

## Server

Browser hooks cannot affect SSR/BFF calls. Use Node middleware for controlled services or route the dependency through the local QA proxy.

Environment policy gates every rule. Use exact matches, bounded application modes and non-production allowlists. This is failure simulation, not load generation.
