#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const relay_1 = require("./relay");
/**
 * `apilens-relay`: runs the relay from environment variables, for a container
 * next to the backend. See docs/backend-relay.md.
 */
const env = process.env;
const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const number = (value) => (value && Number.isFinite(Number(value)) ? Number(value) : undefined);
function fail(message) {
    console.error(`[apilens-relay] ${message}`);
    process.exit(1);
}
if (!env.APILENS_RELAY_ROUTES)
    fail('Set APILENS_RELAY_ROUTES, for example tmf622=https://tmf622.dev.internal,osb=https://osb.dev.internal');
if (!env.APILENS_CONTROL_URL)
    fail('Set APILENS_CONTROL_URL to the app control plane, for example https://clear-dev.example.com/api/__apilens');
if (!env.APILENS_CONTROL_TOKEN)
    fail('Set APILENS_CONTROL_TOKEN to the same token the app uses (APILENS_CONTROL_TOKEN in the app)');
let relay;
try {
    relay = (0, relay_1.createRelay)({
        routes: (0, relay_1.withCallers)((0, relay_1.parseRoutesEnv)(env.APILENS_RELAY_ROUTES), env.APILENS_RELAY_CALLERS),
        control: { url: env.APILENS_CONTROL_URL ?? '', token: env.APILENS_CONTROL_TOKEN ?? '' },
        name: env.APILENS_RELAY_NAME,
        callerName: env.APILENS_RELAY_CALLER,
        sharedEnvironment: env.APILENS_RELAY_SHARED !== 'false',
        captureBodies: { maxBytes: number(env.APILENS_RELAY_MAX_BODY_BYTES), redactKeys: list(env.APILENS_RELAY_REDACT_KEYS) },
        maxRequestBytes: number(env.APILENS_RELAY_MAX_REQUEST_BYTES),
        attributionTimeoutMs: number(env.APILENS_RELAY_ATTRIBUTION_TIMEOUT_MS),
        log: (line) => console.log(`[apilens-relay] ${line}`),
    });
}
catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}
const port = number(env.PORT) ?? 8080;
relay.listen(port).then(() => {
    const status = relay.status();
    console.log(`[apilens-relay] ${status.name} ${status.version} on :${port} · routes ${status.routes.join(', ')} · ${status.sharedEnvironment ? 'shared environment: only QA-session traffic is recorded or mocked' : 'all traffic recorded'}`);
}, (error) => fail(`cannot listen on ${port}: ${error.message}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        void relay.close().finally(() => process.exit(0));
    });
}
//# sourceMappingURL=relay-cli.js.map