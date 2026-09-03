# Security

- Redaction runs before persistence, UI broadcast and export.
- Authorization, cookies, tokens, passwords and payment fields are masked by default.
- The agent binds to loopback and authenticates HTTP/WebSocket clients.
- Bodies and retention are bounded; HTML evidence escapes captured values.
- Production mocking is denied by default through environment policy.

Do not disable masking for shared evidence. Treat replay and proxy configuration as privileged QA actions. Never expose the agent publicly without a security review.
