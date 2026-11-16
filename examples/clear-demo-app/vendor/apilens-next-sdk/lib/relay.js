"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiLensRelay = void 0;
exports.sessionFromHeaders = sessionFromHeaders;
exports.traceFromHeaders = traceFromHeaders;
exports.normaliseRoutes = normaliseRoutes;
exports.withCallers = withCallers;
exports.parseRoutesEnv = parseRoutesEnv;
exports.createRelay = createRelay;
const node_crypto_1 = require("node:crypto");
const node_http_1 = __importDefault(require("node:http"));
const node_https_1 = __importDefault(require("node:https"));
const bodies_1 = require("./bodies");
const incoming_1 = require("./incoming");
const mocks_1 = require("./mocks");
const redaction_1 = require("./redaction");
const version_1 = require("./version");
const SESSION_HEADER = 'x-qa-session-id';
const SCENARIO_HEADER = 'x-test-scenario-id';
const AMBIENT_SESSION_ID = 'apilens-ambient';
const RELAY_PATH = '/__relay';
const MAX_BATCH = 50;
const HARD_REQUEST_CAP = 32 * 1024 * 1024;
/** Never forwarded: they describe one connection, not the request (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const hex = (bytes) => (0, node_crypto_1.randomBytes)(bytes).toString('hex');
const safeId = (value) => value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
function header(req, name) {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}
/** `x-qa-session-id` as a header, or as a W3C baggage entry (OpenTelemetry propagates baggage by default). */
function sessionFromHeaders(req) {
    const direct = safeId(header(req, SESSION_HEADER));
    if (direct)
        return direct;
    for (const entry of (header(req, 'baggage') ?? '').split(',')) {
        const [key, value] = entry.split(';')[0].split('=');
        if (key?.trim().toLowerCase() === SESSION_HEADER && value) {
            try {
                return safeId(decodeURIComponent(value.trim()));
            }
            catch {
                return undefined;
            }
        }
    }
    return undefined;
}
function parseTraceparent(value) {
    const match = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec((value ?? '').trim().toLowerCase());
    if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
        return null;
    return { traceId: match[1], spanId: match[2] };
}
/** B3, which many Spring (Brave/Zipkin) services send instead of traceparent. 64-bit ids are widened to 128. */
function parseB3(single, traceId, spanId) {
    const [trace, span] = single ? single.trim().toLowerCase().split('-') : [traceId?.trim().toLowerCase(), spanId?.trim().toLowerCase()];
    if (!trace || !span || !/^([\da-f]{16}|[\da-f]{32})$/.test(trace) || !/^[\da-f]{16}$/.test(span) || /^0+$/.test(trace))
        return null;
    return { traceId: trace.padStart(32, '0'), spanId: span };
}
/** The caller's trace: W3C first, then B3. */
function traceFromHeaders(req) {
    return parseTraceparent(header(req, 'traceparent')) ?? parseB3(header(req, 'b3'), header(req, 'x-b3-traceid'), header(req, 'x-b3-spanid'));
}
function normaliseRoutes(routes) {
    const list = Array.isArray(routes) ? routes : Object.entries(routes).map(([name, target]) => ({ name, target }));
    const result = new Map();
    for (const { name, target, caller } of list) {
        if (!/^[a-z0-9][\w-]{0,63}$/i.test(name))
            throw new Error(`Relay route name "${name}" must be letters, digits, - or _.`);
        let url;
        try {
            url = new URL(target);
        }
        catch {
            throw new Error(`Relay route "${name}" has a target that is not a URL.`);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            throw new Error(`Relay route "${name}" must target http or https.`);
        url.pathname = url.pathname.replace(/\/+$/, '');
        url.search = '';
        url.hash = '';
        result.set(name.toLowerCase(), { base: url, caller: caller?.trim().slice(0, 200) || null });
    }
    if (result.size === 0)
        throw new Error('The relay needs at least one route.');
    return result;
}
/** Applies `osb=tmf,vesta=tmf` (APILENS_RELAY_CALLERS) to parsed routes. */
function withCallers(routes, callers) {
    const byRoute = parseRoutesEnv(callers);
    for (const name of Object.keys(byRoute)) {
        if (!(name in routes))
            throw new Error(`APILENS_RELAY_CALLERS names "${name}", which is not in APILENS_RELAY_ROUTES.`);
    }
    return Object.entries(routes).map(([name, target]) => ({ name, target, ...(byRoute[name] ? { caller: byRoute[name] } : {}) }));
}
/** Parses `tmf622=https://a,tmf629=https://b` (commas or newlines). */
function parseRoutesEnv(value) {
    const routes = {};
    for (const entry of (value ?? '').split(/[,\n]/)) {
        const trimmed = entry.trim();
        if (!trimmed)
            continue;
        const at = trimmed.indexOf('=');
        if (at <= 0)
            throw new Error(`APILENS_RELAY_ROUTES entry "${trimmed}" is not name=url.`);
        routes[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
    }
    return routes;
}
/** Headers to send upstream: everything the backend sent, minus connection-level ones. */
function forwardHeaders(req, target, bodyLength) {
    const listed = new Set((header(req, 'connection') ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean));
    const result = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || listed.has(name) || name === 'host')
            continue;
        result[name] = value;
    }
    result.host = target.host;
    if (bodyLength !== null) {
        delete result['content-length'];
        if (bodyLength > 0 || !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method ?? 'GET'))
            result['content-length'] = String(bodyLength);
    }
    return result;
}
/** The upstream response headers as a flat [name, value, …] list, keeping repeated headers such as set-cookie. */
function responseHeaderList(raw, drop = new Set()) {
    const result = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
        const name = raw[index].toLowerCase();
        if (HOP_BY_HOP.has(name) || drop.has(name))
            continue;
        result.push(raw[index], raw[index + 1]);
    }
    return result;
}
function headersFromRaw(raw) {
    const headers = new Headers();
    for (let index = 0; index + 1 < raw.length; index += 2) {
        try {
            headers.append(raw[index], raw[index + 1]);
        }
        catch {
            // A header the platform rejects is simply not recorded.
        }
    }
    return headers;
}
function nodeRequestHeaders(req) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined)
            continue;
        for (const item of Array.isArray(value) ? value : [value]) {
            try {
                headers.append(name, item);
            }
            catch {
                // Skipped, as above.
            }
        }
    }
    return headers;
}
function readAll(req, cap) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.byteLength;
            if (size > cap) {
                resolve(null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
async function captureBuffer(bytes, contentType, contentEncoding, config) {
    if (bytes.byteLength === 0)
        return { body: null, omitted: null };
    const decoded = await (0, incoming_1.decodeBody)(bytes, contentEncoding, config.maxBytes);
    if (!decoded)
        return { body: null, omitted: `Not captured: ${contentEncoding} body could not be decoded` };
    return (0, bodies_1.captureBytes)(decoded.subarray(0, config.maxBytes), decoded.byteLength > config.maxBytes, contentType, config);
}
class ApiLensRelay {
    options;
    routes;
    controlUrl;
    bodyConfig;
    shared;
    name;
    caller;
    maxRequestBytes;
    maxQueue;
    log;
    agents = { http: new node_http_1.default.Agent({ keepAlive: true }), https: new node_https_1.default.Agent({ keepAlive: true }) };
    rules = [];
    queue = [];
    flushing = false;
    lastDelivery = 0;
    timers = [];
    server = null;
    lastControlError = null;
    failing = new Map();
    /** Calls whose response is still on its way, so flush() can wait for them. */
    open = new Set();
    stats = { forwarded: 0, captured: 0, unattributed: 0, mocked: 0, upstreamErrors: 0, dropped: 0 };
    constructor(options) {
        this.options = options;
        this.routes = normaliseRoutes(options.routes);
        if (!/^https?:\/\//.test(options.control?.url ?? ''))
            throw new Error('control.url must be the app control plane, such as https://app.example/api/__apilens.');
        if (!options.control.token || options.control.token.length < 24)
            throw new Error('control.token must be the app control token (24+ characters).');
        this.controlUrl = options.control.url.replace(/\/+$/, '');
        this.bodyConfig = (0, bodies_1.resolveBodyCapture)(options.captureBodies);
        this.shared = options.sharedEnvironment !== false;
        this.name = safeId(options.name) ?? 'apilens-relay';
        this.caller = (options.callerName ?? 'backend').slice(0, 200);
        this.maxRequestBytes = Math.min(options.maxRequestBytes ?? 8 * 1024 * 1024, HARD_REQUEST_CAP);
        this.maxQueue = options.maxQueue ?? 1_000;
        this.log = options.log ?? (() => undefined);
    }
    status() {
        return { name: this.name, version: version_1.SDK_VERSION, routes: [...this.routes.keys()], sharedEnvironment: this.shared, ...this.stats };
    }
    get lastError() { return this.lastControlError; }
    /** Starts listening and the background rule refresh and delivery. */
    async listen(port, host = '0.0.0.0') {
        const server = node_http_1.default.createServer((req, res) => void this.handle(req, res));
        // Upstreams such as OSB can take a while; the backend's own client timeout decides, not ours.
        server.requestTimeout = 0;
        server.headersTimeout = 60_000;
        server.keepAliveTimeout = 65_000;
        this.server = server;
        this.start();
        await new Promise((resolve) => server.listen(port, host, resolve));
        return server;
    }
    /** Background work only, for tests or when mounting `handle` on your own server. */
    start() {
        if (this.timers.length)
            return;
        void this.refreshRules();
        const every = (ms, task) => {
            const timer = setInterval(task, ms);
            timer.unref();
            this.timers.push(timer);
        };
        every(this.options.rulesIntervalMs ?? 2_000, () => void this.refreshRules());
        every(this.options.flushIntervalMs ?? 250, () => {
            const idle = Date.now() - this.lastDelivery > (this.options.heartbeatMs ?? 15_000);
            if (this.queue.length || idle)
                void this.flush();
        });
    }
    async close() {
        for (const timer of this.timers)
            clearInterval(timer);
        this.timers = [];
        await this.flush();
        this.agents.http.destroy();
        this.agents.https.destroy();
        const server = this.server;
        this.server = null;
        if (server)
            await new Promise((resolve) => server.close(() => resolve()));
    }
    async handle(req, res) {
        const rawPath = req.url ?? '/';
        if (rawPath === `${RELAY_PATH}/health` || rawPath === `${RELAY_PATH}/ready`) {
            // Probes only: no traffic, no addresses, no counters.
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, name: this.name, version: version_1.SDK_VERSION, routes: [...this.routes.keys()] }));
            return;
        }
        const match = /^\/([^/?#]+)([^#]*)$/.exec(rawPath);
        const routeName = match?.[1]?.toLowerCase() ?? '';
        const route = this.routes.get(routeName);
        if (!route) {
            res.writeHead(502, { 'content-type': 'application/json', 'x-apilens-relay': 'no-route' });
            res.end(JSON.stringify({ error: `ApiLens relay has no route "${routeName}". Known routes: ${[...this.routes.keys()].join(', ')}.` }));
            return;
        }
        const base = route.base;
        const rest = match[2] ?? '';
        const target = new URL(base.href);
        const queryAt = rest.indexOf('?');
        target.pathname = `${base.pathname.replace(/\/+$/, '')}${queryAt >= 0 ? rest.slice(0, queryAt) : rest}` || '/';
        target.search = queryAt >= 0 ? rest.slice(queryAt) : '';
        this.stats.forwarded += 1;
        const session = sessionFromHeaders(req);
        const attributed = session !== undefined && session !== AMBIENT_SESSION_ID;
        if (!attributed)
            this.stats.unattributed += 1;
        if (!attributed && this.shared) {
            this.pipe(req, res, target);
            return;
        }
        const declared = Number(header(req, 'content-length') ?? '0');
        if (declared > this.maxRequestBytes) {
            // Too large to hold for matching; forwarded as is and recorded without bodies or mocks.
            this.pipe(req, res, target, this.pending(req, routeName, route.caller, target, session ?? AMBIENT_SESSION_ID, { body: null, omitted: `Not captured: larger than ${this.maxRequestBytes} bytes` }));
            return;
        }
        let body;
        try {
            body = await readAll(req, this.maxRequestBytes);
        }
        catch {
            return; // The backend went away mid-request.
        }
        if (body === null) {
            res.writeHead(413, { 'content-type': 'application/json', 'x-apilens-relay': 'too-large' });
            res.end(JSON.stringify({ error: `Request body exceeds the relay limit of ${this.maxRequestBytes} bytes (APILENS_RELAY_MAX_REQUEST_BYTES).` }));
            return;
        }
        const requestCapture = this.bodyConfig.request
            ? await captureBuffer(body, header(req, 'content-type') ?? null, header(req, 'content-encoding') ?? null, this.bodyConfig)
            : { body: null, omitted: null };
        const pending = this.pending(req, routeName, route.caller, target, session ?? AMBIENT_SESSION_ID, requestCapture);
        let decision = { rule: null, skipped: [] };
        try {
            decision = (0, mocks_1.selectMockRule)(
            // Never answer another squad's traffic: a rule only applies to a QA session.
            attributed ? this.rules : this.rules.filter((rule) => !rule.match.sessionId), {
                kind: 'client', method: pending.method, url: target.toString(), headers: pending.requestHeaders,
                bodyText: requestCapture.body?.encoding === 'utf8' ? requestCapture.body.content : body.byteLength <= 1_048_576 ? body.toString('utf8') : null,
                sessionId: pending.sessionId,
            });
        }
        catch {
            // A broken rule never breaks the backend's request.
        }
        const rule = decision.rule;
        if (rule && rule.action.type !== 'passthrough-mutate') {
            await this.serveMock(rule, req, res, pending);
            return;
        }
        this.forward(req, res, target, body, pending, rule);
    }
    pending(req, route, caller, target, sessionId, request) {
        let settle = () => undefined;
        const done = new Promise((resolve) => { settle = resolve; });
        this.open.add(done);
        void done.then(() => this.open.delete(done));
        return {
            settle,
            recorded: false,
            route,
            caller: caller ?? this.caller,
            method: (req.method ?? 'GET').toUpperCase(),
            targetUrl: target.toString(),
            sessionId,
            scenarioId: safeId(header(req, SCENARIO_HEADER)) ?? null,
            trace: traceFromHeaders(req),
            startedAt: Date.now(),
            requestHeaders: nodeRequestHeaders(req),
            request,
        };
    }
    transport(target) {
        return target.protocol === 'https:' ? { request: node_https_1.default.request, agent: this.agents.https } : { request: node_http_1.default.request, agent: this.agents.http };
    }
    upstreamFailed(res, target, error) {
        this.stats.upstreamErrors += 1;
        this.log(`upstream ${target.host} failed: ${error.message}`);
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.writeHead(502, { 'content-type': 'application/json', 'x-apilens-relay': 'upstream-unreachable' });
        res.end(JSON.stringify({ error: `ApiLens relay could not reach ${target.host}: ${error.message}` }));
    }
    /** Streams the request and response through untouched; records afterwards when `pending` is given. */
    pipe(req, res, target, pending) {
        const { request, agent } = this.transport(target);
        const upstream = request(target, { method: req.method, headers: forwardHeaders(req, target, null), agent }, (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.statusMessage, responseHeaderList(answer.rawHeaders));
            answer.pipe(res);
            if (pending) {
                answer.on('end', () => {
                    this.record(pending, {
                        statusCode: answer.statusCode ?? null, responseHeaders: headersFromRaw(answer.rawHeaders),
                        response: { body: null, omitted: 'Not captured: request was too large to buffer' }, bodyAt: Date.now(), error: null, mockedBy: null,
                    });
                });
            }
        });
        upstream.on('error', (error) => {
            this.upstreamFailed(res, target, error);
            if (pending)
                this.record(pending, { statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null, error: error.message, mockedBy: null });
        });
        res.on('close', () => {
            if (res.writableFinished)
                return;
            upstream.destroy();
            if (pending)
                this.abandoned(pending);
        });
        req.pipe(upstream);
    }
    forward(req, res, target, body, pending, mutate) {
        const { request, agent } = this.transport(target);
        const upstream = request(target, { method: req.method, headers: forwardHeaders(req, target, body.byteLength), agent }, (answer) => {
            const status = answer.statusCode ?? 502;
            const contentType = answer.headers['content-type'] ?? null;
            const contentEncoding = answer.headers['content-encoding'] ?? null;
            const finish = (captured, truncated, mockedBy, encoding) => {
                const bodyAt = Date.now();
                void (async () => {
                    const response = this.bodyConfig.response
                        ? await captureBuffer(captured, contentType, encoding, this.bodyConfig).then((outcome) => truncated && outcome.body ? { ...outcome, body: { ...outcome.body, truncated: true } } : outcome)
                        : { body: null, omitted: null };
                    this.record(pending, { statusCode: status, responseHeaders: headersFromRaw(answer.rawHeaders), response, bodyAt, error: null, mockedBy });
                })();
            };
            if (mutate) {
                // The real answer, changed: needs the whole body, decoded, before anything is sent.
                const chunks = [];
                answer.on('data', (chunk) => chunks.push(chunk));
                answer.on('end', () => {
                    void (async () => {
                        const raw = Buffer.concat(chunks);
                        const decoded = await (0, incoming_1.decodeBody)(raw, contentEncoding, HARD_REQUEST_CAP);
                        const text = decoded ? (0, mocks_1.applyFieldMutations)(decoded.toString('utf8'), mutate.action.fieldMutations ?? []) : null;
                        const out = text === null ? raw : Buffer.from(text, 'utf8');
                        const drop = new Set(['content-length', ...(text === null ? [] : ['content-encoding', 'etag'])]);
                        res.writeHead(status, answer.statusMessage, [...responseHeaderList(answer.rawHeaders, drop), 'content-length', String(out.byteLength), 'x-apilens-mock', mutate.name.replace(/[^\x20-\x7E]/g, '?').slice(0, 128)]);
                        res.end(out);
                        this.applied(mutate);
                        finish(out, false, mutate.name, text === null ? contentEncoding : null);
                    })();
                });
                return;
            }
            res.writeHead(status, answer.statusMessage, responseHeaderList(answer.rawHeaders));
            const cap = this.bodyConfig.response ? this.bodyConfig.maxBytes : 0;
            const tapped = [];
            let size = 0;
            let truncated = false;
            answer.on('data', (chunk) => {
                if (size < cap) {
                    tapped.push(chunk.subarray(0, cap - size));
                    if (chunk.byteLength > cap - size)
                        truncated = true;
                    size += Math.min(chunk.byteLength, cap - size);
                }
                else if (chunk.byteLength) {
                    truncated = cap > 0;
                }
            });
            answer.on('end', () => finish(Buffer.concat(tapped), truncated, null, contentEncoding));
            answer.pipe(res);
        });
        upstream.on('error', (error) => {
            this.upstreamFailed(res, target, error);
            this.record(pending, { statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null, error: error.message, mockedBy: null });
        });
        res.on('close', () => {
            if (res.writableFinished)
                return;
            upstream.destroy();
            this.abandoned(pending);
        });
        upstream.end(body);
    }
    async serveMock(rule, req, res, pending) {
        const abort = new AbortController();
        res.on('close', () => abort.abort());
        this.applied(rule);
        try {
            const response = await (0, mocks_1.buildMockResponse)(rule, abort.signal);
            const text = await response.text();
            const headers = [];
            response.headers.forEach((value, name) => headers.push(name, value));
            res.writeHead(response.status, response.statusText || undefined, [...headers, 'content-length', String(Buffer.byteLength(text))]);
            res.end(text);
            const response_ = await captureBuffer(Buffer.from(text, 'utf8'), response.headers.get('content-type'), null, this.bodyConfig);
            this.record(pending, { statusCode: response.status, responseHeaders: response.headers, response: response_, bodyAt: Date.now(), error: null, mockedBy: rule.name });
        }
        catch (error) {
            if (abort.signal.aborted) {
                this.abandoned(pending, rule.name);
                return;
            }
            // A simulated network failure: the backend sees the connection drop, exactly as if the service were down.
            req.socket.destroy();
            const message = error instanceof mocks_1.MockNetworkError ? error.message : 'Mock failed';
            this.record(pending, { statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null, error: message, mockedBy: rule.name });
        }
    }
    /** The backend hung up (usually its own client timeout) before the answer arrived. */
    abandoned(pending, mockedBy = null) {
        this.record(pending, {
            statusCode: null, responseHeaders: new Headers(), response: { body: null, omitted: null }, bodyAt: null,
            error: 'The backend closed the connection before the answer arrived (its own timeout?)', mockedBy,
        });
    }
    applied(rule) {
        this.stats.mocked += 1;
        rule.appliedCount += 1;
        // Apply budgets ("once") are counted where the rules live.
        void this.control('consume', { method: 'POST', body: JSON.stringify({ ruleIds: [rule.id] }) });
    }
    record(pending, outcome) {
        if (pending.recorded)
            return;
        pending.recorded = true;
        const endedAt = Date.now();
        const parts = (0, redaction_1.safeUrlParts)(pending.targetUrl);
        this.stats.captured += 1;
        pending.settle();
        this.queue.push({
            spanId: hex(8),
            traceId: pending.trace?.traceId ?? hex(16),
            parentSpanId: pending.trace?.spanId ?? null,
            sessionId: pending.sessionId,
            scenarioId: pending.scenarioId,
            serviceName: pending.caller,
            kind: 'client',
            method: pending.method,
            url: parts.url,
            origin: parts.origin,
            path: parts.path,
            query: parts.query,
            statusCode: outcome.statusCode,
            status: outcome.error || (outcome.statusCode ?? 0) >= 400 ? 'error' : 'ok',
            startedAt: pending.startedAt,
            endedAt,
            durationMs: endedAt - pending.startedAt,
            bodyDurationMs: outcome.response.body && outcome.bodyAt ? outcome.bodyAt - pending.startedAt : null,
            requestHeaders: (0, redaction_1.redactHeaders)(pending.requestHeaders),
            responseHeaders: (0, redaction_1.redactHeaders)(outcome.responseHeaders),
            requestBody: pending.request.body,
            responseBody: outcome.response.body,
            requestBodyOmitted: pending.request.omitted,
            responseBodyOmitted: outcome.response.omitted,
            error: outcome.error,
            mockedBy: outcome.mockedBy,
            layer: pending.route,
        });
        if (this.queue.length > this.maxQueue) {
            const excess = this.queue.length - this.maxQueue;
            this.queue.splice(0, excess);
            this.stats.dropped += excess;
        }
    }
    /** Delivers queued calls, with this relay's status, to the control plane. */
    async flush() {
        if (this.flushing)
            return;
        this.flushing = true;
        if (this.open.size) {
            // Responses that finish within a moment go out in this delivery; a hung one never holds it up.
            await Promise.race([Promise.all([...this.open]), new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
        }
        try {
            do {
                const batch = this.queue.slice(0, MAX_BATCH);
                const delivered = await this.control('ingest', { method: 'POST', body: JSON.stringify({ calls: batch, relay: this.status() }) });
                if (!delivered)
                    break; // Kept for the next tick; maxQueue bounds the wait.
                this.queue.splice(0, batch.length);
                this.lastDelivery = Date.now();
            } while (this.queue.length);
        }
        finally {
            this.flushing = false;
        }
    }
    async refreshRules() {
        const response = await this.control('rules', { method: 'GET' });
        const payload = response ? (await response.json().catch(() => null)) : null;
        if (!Array.isArray(payload?.rules))
            return;
        const now = Date.now();
        const local = new Map(this.rules.map((rule) => [rule.id, rule.appliedCount]));
        this.rules = payload.rules
            .map((rule) => (0, mocks_1.sanitizeRule)(rule, now))
            .filter((rule) => rule !== null)
            // A "once" rule this relay just used stays used until the app's count catches up.
            .map((rule) => ({ ...rule, appliedCount: Math.max(rule.appliedCount, local.get(rule.id) ?? 0) }));
    }
    async control(operation, init) {
        try {
            const response = await fetch(`${this.controlUrl}/${operation}`, {
                ...init,
                signal: AbortSignal.timeout(this.options.control.timeoutMs ?? 5_000),
                headers: { ...(this.options.control.headers ?? {}), authorization: `Bearer ${this.options.control.token}`, 'content-type': 'application/json' },
            });
            if (!response.ok)
                throw new Error(`HTTP ${response.status}${response.status === 401 ? ' (APILENS_CONTROL_TOKEN does not match the app)' : ''}`);
            if (this.failing.delete(operation))
                this.log(`control plane ${operation}: working again`);
            if (!this.failing.size)
                this.lastControlError = null;
            return response;
        }
        catch (cause) {
            const message = `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`;
            // Logged when it starts failing or the reason changes, not on every retry.
            if (this.failing.get(operation) !== message)
                this.log(`control plane ${message}`);
            this.failing.set(operation, message);
            this.lastControlError = message;
            return null;
        }
    }
}
exports.ApiLensRelay = ApiLensRelay;
function createRelay(options) {
    return new ApiLensRelay(options);
}
//# sourceMappingURL=relay.js.map