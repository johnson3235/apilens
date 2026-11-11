# Security

- Redaction runs before persistence, UI broadcast and export.
- Authorization, cookies, tokens, passwords and payment fields are masked by default.
- The agent binds to loopback and authenticates HTTP/WebSocket clients.
- Bodies and retention are bounded; HTML evidence escapes captured values.
- Production mocking is denied by default through environment policy.

## Server SDK control plane

- The control token (24+ characters, different from the agent token) is compared in constant time; ten failures lock the endpoint for a minute. A disabled, misconfigured or expired control plane answers 404 and never stops the application from booting.
- `control.expiresAt` ends a token's life with the QA exercise; rotate the token after each exercise either way. Use it on dev only, never preprod or prod.
- Payloads are redacted before they are buffered: credential, card and bank keys, personal-data keys (`msisdn`, phone, e-mail, date of birth) and JWT, bearer, card-number, IBAN and e-mail values. Add application keys with `captureBodies.redactKeys`. This is a strong default, not a PII guarantee.
- Captures are bounded per body (`captureBodies.maxBytes`) and in total (`control.maxBufferBytes`, default 32 MB), and live only in process memory.
- The extension's session tag (`x-qa-session-id`) is correlation metadata limited to the recording tab and the app's host, not access control.

Do not disable masking for shared evidence. Treat replay and proxy configuration as privileged QA actions. Never expose the agent publicly without a security review.
