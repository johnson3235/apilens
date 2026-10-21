"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiLensNextSDK = exports.AMBIENT_SESSION_ID = exports.SDK_VERSION = exports.MIN_TOKEN_LENGTH = exports.DEFAULT_TEXT_CONTENT_TYPES = void 0;
exports.safeHeaders = safeHeaders;
const node_async_hooks_1 = require("node:async_hooks");
const node_crypto_1 = require("node:crypto");
const node_http_1 = require("node:http");
const bodies_1 = require("./bodies");
const buffer_1 = require("./buffer");
const control_1 = require("./control");
const mocks_1 = require("./mocks");
const redaction_1 = require("./redaction");
const types_1 = require("./types");
__exportStar(require("./types"), exports);
var bodies_2 = require("./bodies");
Object.defineProperty(exports, "DEFAULT_TEXT_CONTENT_TYPES", { enumerable: true, get: function () { return bodies_2.DEFAULT_TEXT_CONTENT_TYPES; } });
var control_2 = require("./control");
Object.defineProperty(exports, "MIN_TOKEN_LENGTH", { enumerable: true, get: function () { return control_2.MIN_TOKEN_LENGTH; } });
exports.SDK_VERSION = '0.2.0';
/**
 * Session id used when `captureWithoutSession` is on.
 *
 * A shared dev deployment serves testers who cannot inject headers, so their
 * traffic is grouped here rather than discarded.
 */
exports.AMBIENT_SESSION_ID = 'apilens-ambient';
const id = (bytes) => (0, node_crypto_1.randomBytes)(bytes).toString('hex');
const safeId = (value) => value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
function safeHeaders(headers) {
    return (0, redaction_1.redactHeaders)(headers);
}
function safeUrl(value) {
    return (0, redaction_1.safeUrlParts)(value).url;
}
/** Local-only transport, authenticated /v1/spans, never uses instrumented fetch. */
class Reporter {
    options;
    pending = [];
    active = null;
    timer = null;
    diagnostics = { accepted: 0, dropped: 0, lastError: null };
    endpoint;
    constructor(options) {
        this.options = options;
        // A remote dev server's 127.0.0.1 is not the tester's laptop, so agent
        // delivery is skipped entirely there and the control plane is used instead.
        if (options.reportToAgent === false) {
            this.endpoint = null;
            return;
        }
        this.endpoint = new URL('/v1/spans', options.agentUrl ?? 'http://127.0.0.1:7317');
        if (this.endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(this.endpoint.hostname) || this.endpoint.username || this.endpoint.password) {
            throw new Error('ApiLens requires an HTTP loopback agent in this release. Set reportToAgent: false and use the control plane for remote servers.');
        }
    }
    get active$() { return this.endpoint !== null; }
    add(span) {
        if (!this.endpoint)
            return;
        if (this.pending.length >= 1000) {
            this.diagnostics.dropped++;
            return;
        }
        this.pending.push(span);
        if (!this.timer) {
            this.timer = setInterval(() => { void this.flush(); }, 1000);
            this.timer.unref();
        }
    }
    async flush() {
        if (!this.endpoint)
            return;
        if (this.active) {
            await this.active;
            return this.flush();
        }
        if (!this.pending.length)
            return;
        const batch = this.pending.splice(0, 100);
        this.active = (async () => {
            // Agent ingestion accepts one session per request; never mix concurrent testers.
            const groups = new Map();
            for (const span of batch)
                groups.set(span.sessionId, [...(groups.get(span.sessionId) ?? []), span]);
            for (const [sessionId, spans] of groups) {
                try {
                    await this.send(JSON.stringify({ sessionId, spans }));
                    this.diagnostics.accepted += spans.length;
                    this.diagnostics.lastError = null;
                }
                catch (error) {
                    this.diagnostics.dropped += spans.length;
                    this.diagnostics.lastError = error instanceof Error ? error.message : 'Agent delivery failed';
                }
            }
        })();
        try {
            await this.active;
        }
        finally {
            this.active = null;
        }
        // Bounded flush: later calls flush requests that arrived during this batch.
    }
    send(body) {
        return new Promise((resolve, reject) => {
            const request = (0, node_http_1.request)(this.endpoint, { method: 'POST', headers: {
                    authorization: `Bearer ${this.options.agentToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
                } }, (response) => {
                response.resume();
                response.on('error', () => reject(new Error('Agent response failed')));
                response.on('end', () => response.statusCode === 202 ? resolve() : reject(new Error(`Agent HTTP ${response.statusCode}`)));
            });
            const timeout = setTimeout(() => request.destroy(new Error('Agent delivery timed out')), 2000);
            timeout.unref();
            request.on('close', () => clearTimeout(timeout));
            request.on('error', () => reject(new Error('Agent unavailable or request timed out')));
            request.end(body);
        });
    }
    async shutdown() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        await this.active;
        while (this.pending.length)
            await this.flush();
    }
}
class ApiLensNextSDK {
    options;
    contexts = new node_async_hooks_1.AsyncLocalStorage();
    insideFetch = new node_async_hooks_1.AsyncLocalStorage();
    reporter;
    buffer;
    bodyCapture;
    control;
    wrapper = null;
    downstream = null;
    stopped = false;
    allowed;
    allowAnyOrigin;
    propagate;
    rules = [];
    rulesRev = (0, control_1.buildRulesRevision)([]);
    /** Recording runs off the request's critical path; `flush()` drains it. */
    pendingRecords = new Set();
    /** Set once this process answers the extension: from then on it keeps calls itself. */
    servedControl = false;
    relayFailures = 0;
    lastRelayError = null;
    /** Distinguishes a restarted server from an idle one in the extension. */
    processId = id(8);
    startedAt = Date.now();
    constructor(options) {
        this.options = options;
        // Defaults to on so an existing local setup keeps delivering spans; remote
        // deployments must opt out explicitly and use the control plane instead.
        const reportToAgent = options.reportToAgent !== false;
        if (options.enabled && reportToAgent && !options.agentToken) {
            throw new Error('ApiLens agentToken is required when enabled. Set reportToAgent: false to use the control plane only.');
        }
        if (options.control?.enabled && !(0, control_1.isTokenAcceptable)(options.control.token)) {
            throw new Error(`ApiLens control.token must be at least ${control_1.MIN_TOKEN_LENGTH} characters.`);
        }
        if (options.control?.enabled && options.control.token === options.agentToken) {
            throw new Error('ApiLens control.token must differ from agentToken so a leaked control token cannot reach the agent.');
        }
        this.allowAnyOrigin = options.allowedAppOrigins.includes('*');
        this.allowed = new Set(options.allowedAppOrigins.filter((origin) => origin !== '*').map((origin) => new URL(origin).origin));
        this.propagate = new Set((options.propagateToOrigins ?? []).map((origin) => new URL(origin).origin));
        this.bodyCapture = (0, bodies_1.resolveBodyCapture)(options.captureBodies);
        this.buffer = new buffer_1.CallBuffer(Math.max(50, Math.min(options.control?.bufferSize ?? 500, 5_000)));
        this.reporter = new Reporter(options);
        this.control = options.control?.enabled
            ? (0, control_1.createControlHandler)({
                options: options.control,
                processId: this.processId,
                buffer: this.buffer,
                health: () => this.health(),
                getRules: () => this.rules,
                setRules: (rules) => this.applyRules(rules),
                rulesRevision: () => this.rulesRev,
                clearCalls: () => this.buffer.clear(),
                ingest: (calls) => this.ingestRelayed(calls),
                consume: (ruleIds) => {
                    for (const rule of this.rules)
                        if (ruleIds.includes(rule.id))
                            rule.appliedCount += 1;
                },
            })
            : null;
    }
    get diagnostics() { return { ...this.reporter.diagnostics, relayFailures: this.relayFailures, lastRelayError: this.lastRelayError }; }
    get enabled() { return this.options.enabled === true && !this.stopped; }
    /** True when the extension can reach this process over the control plane. */
    get controlEnabled() { return this.control !== null && this.enabled; }
    health() {
        return {
            ok: true,
            protocolVersion: types_1.CONTROL_PROTOCOL_VERSION,
            sdkVersion: exports.SDK_VERSION,
            serviceName: this.options.serviceName,
            processId: this.processId,
            startedAt: this.startedAt,
            enabled: this.enabled,
            captureRequestBodies: this.bodyCapture.request,
            captureResponseBodies: this.bodyCapture.response,
            maxBodyBytes: this.bodyCapture.maxBytes,
            mockingEnabled: this.options.control?.allowMockControl !== false,
            routeMocksEnabled: this.options.allowRouteMocks === true,
            bufferedCalls: this.buffer.size(),
            latestSeq: this.buffer.latestSeq(),
            droppedCalls: this.buffer.droppedCount(),
            ruleCount: this.rules.length,
            activeRuleCount: this.rules.filter((rule) => rule.enabled).length,
            agentDelivery: { ...this.reporter.diagnostics },
        };
    }
    /** Calls captured so far, newest last. Useful for assertions in automated tests. */
    calls() { return this.buffer.all(); }
    clearCalls() { this.buffer.clear(); }
    serverMockRules() { return [...this.rules]; }
    /** Replaces the active server mock rules, normalising anything untrusted. */
    setServerMockRules(rules) {
        const now = Date.now();
        this.applyRules(rules.map((rule) => (0, mocks_1.sanitizeRule)(rule, now)).filter((rule) => rule !== null));
        return this.serverMockRules();
    }
    applyRules(rules) {
        this.rules = rules;
        this.rulesRev = (0, control_1.buildRulesRevision)(rules);
    }
    /**
     * Handles one control-plane request.
     *
     * Mount from a catch-all Node-runtime route such as
     * `src/app/api/%5F_apilens/[[...segments]]/route.ts` (served at `/api/__apilens`;
     * a folder starting with `_` is private in the App Router and never routed).
     */
    async handleControlRequest(request) {
        if (!this.control) {
            return new Response(JSON.stringify({ error: 'Not found' }), {
                status: 404,
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
            });
        }
        const response = await this.control(request);
        if (response.status < 400)
            this.servedControl = true;
        return response;
    }
    /** Ready-made App Router exports for the control route file. */
    controlRoute() {
        const handle = (request) => this.handleControlRequest(request);
        return { GET: handle, POST: handle, PUT: handle, DELETE: handle, OPTIONS: handle };
    }
    /** Call from instrumentation.ts register(), and once per route to tolerate Next's fetch patching. */
    installFetch() {
        if (!this.enabled || globalThis.fetch === this.wrapper)
            return;
        const downstream = globalThis.fetch;
        const sdk = this;
        this.downstream = downstream;
        this.wrapper = function apiLensFetch(input, init) {
            const ctx = sdk.contexts.getStore();
            if (!sdk.enabled || !ctx || sdk.insideFetch.getStore())
                return downstream(input, init);
            return sdk.insideFetch.run(true, () => sdk.instrumentedFetch(downstream, ctx, input, init));
        };
        globalThis.fetch = this.wrapper;
    }
    async instrumentedFetch(downstream, ctx, input, init) {
        const requestInput = input instanceof Request ? input : null;
        const url = requestInput?.url ?? String(input);
        const method = (init?.method ?? requestInput?.method ?? 'GET').toUpperCase();
        const headers = new Headers(init?.headers ?? requestInput?.headers);
        const spanId = id(8);
        const startedAt = Date.now();
        const signal = init?.signal ?? requestInput?.signal ?? null;
        // Cloning happens before the request is dispatched; the caller's own body
        // stream is never touched.
        const requestCapture = this.bodyCapture.request
            ? init?.body !== undefined && init?.body !== null
                ? (0, bodies_1.captureInitBody)(init.body, headers.get('content-type'), this.bodyCapture)
                : requestInput
                    ? (0, bodies_1.captureMessageBody)(requestInput, this.bodyCapture)
                    : null
            : null;
        const decision = await this.decide('client', method, url, headers, ctx, requestCapture);
        if (decision.rule && decision.rule.action.type !== 'passthrough-mutate') {
            return this.serveMock(decision.rule, decision.skipped, ctx, spanId, method, url, headers, startedAt, requestCapture, signal, () => downstream(input, init));
        }
        let outgoing = init;
        try {
            if (this.propagate.has(new URL(url).origin)) {
                headers.set('traceparent', `00-${ctx.traceId}-${spanId}-01`);
                headers.set('x-qa-session-id', ctx.sessionId);
                if (ctx.scenarioId)
                    headers.set('x-test-scenario-id', ctx.scenarioId);
                outgoing = { ...init, headers }; // Keep body, signal, cache, next and duplex untouched.
            }
        }
        catch {
            // A non-absolute URL simply never matches a propagation origin.
        }
        let response;
        try {
            response = await downstream(input, outgoing);
        }
        catch (cause) {
            this.track(this.finishRecord({
                ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
                statusCode: null, requestHeaders: headers, responseHeaders: null,
                error: cause instanceof Error ? cause.name : 'FetchError',
                requestCapture, responseCapture: null, mockedBy: null, skipped: decision.skipped,
            }));
            throw cause;
        }
        if (decision.rule) {
            return this.mutatePassthrough(decision.rule, decision.skipped, response, ctx, spanId, method, url, headers, startedAt, requestCapture);
        }
        const responseCapture = this.bodyCapture.response ? (0, bodies_1.captureMessageBody)(response, this.bodyCapture) : null;
        this.track(this.finishRecord({
            ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
            statusCode: response.status, requestHeaders: headers, responseHeaders: response.headers,
            error: null, requestCapture, responseCapture, mockedBy: null, skipped: decision.skipped,
        }));
        return response;
    }
    /** Preserves NextRequest and params context. */
    wrapRoute(handler) {
        return async (request, context) => {
            const headerSession = safeId(request.headers.get('x-qa-session-id'));
            const sessionId = headerSession ?? (this.options.captureWithoutSession ? exports.AMBIENT_SESSION_ID : undefined);
            if (!this.enabled || !sessionId || !this.originAllowed(request.url))
                return handler(request, context);
            this.installFetch();
            const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(request.headers.get('traceparent') ?? '');
            const validParent = parent && !/^0+$/.test(parent[1]) && !/^0+$/.test(parent[2]) ? parent : null;
            const relayTo = this.relayTarget(request.url);
            if (relayTo)
                await this.pullRules(relayTo);
            const ctx = { sessionId, scenarioId: safeId(request.headers.get('x-test-scenario-id')), traceId: validParent?.[1] ?? id(16), spanId: id(8), relayTo };
            const startedAt = Date.now();
            const method = request.method.toUpperCase();
            return this.contexts.run(ctx, async () => {
                const requestCapture = this.bodyCapture.request ? (0, bodies_1.captureMessageBody)(request, this.bodyCapture) : null;
                if (this.options.allowRouteMocks) {
                    const decision = await this.decide('server', method, request.url, request.headers, ctx, requestCapture);
                    if (decision.rule && decision.rule.action.type !== 'passthrough-mutate') {
                        return this.serveMock(decision.rule, decision.skipped, ctx, ctx.spanId, method, request.url, request.headers, startedAt, requestCapture, request.signal ?? null, async () => handler(request, context));
                    }
                }
                let response;
                let error = null;
                try {
                    response = await handler(request, context);
                    return response;
                }
                catch (cause) {
                    error = cause instanceof Error ? cause.name : 'HandlerError';
                    throw cause;
                }
                finally {
                    const responseCapture = response && this.bodyCapture.response ? (0, bodies_1.captureMessageBody)(response, this.bodyCapture) : null;
                    this.track(this.finishRecord({
                        ctx, spanId: ctx.spanId, parentSpanId: validParent?.[2] ?? null, kind: 'server', method,
                        url: request.url, startedAt, statusCode: response?.status ?? null,
                        requestHeaders: request.headers, responseHeaders: response?.headers ?? null,
                        error, requestCapture, responseCapture, mockedBy: null, skipped: [],
                    }));
                }
            });
        };
    }
    /**
     * Captures server-side rendering work as a page call.
     *
     * Server Components, `generateMetadata` and server actions have no Request
     * for `wrapRoute` to wrap, so the backend fetches they make would otherwise
     * go uncaptured — and the browser never sees them either. Run the data
     * loading inside `traceRender` and each fetch becomes a backend call under
     * one page call:
     *
     *   const data = await apiLens.traceRender(
     *     { path: `/myaccount/billing?contactId=${id}`, headers: headers() },
     *     () => loadBilling(id),
     *   );
     *
     * `headers` (from `next/headers`) supplies the host, the QA session and the
     * incoming trace. A plain-object or array result is captured as the page
     * call's "Received" body. Next's redirect/notFound signals are recorded as
     * 307/404, not failures. Server mocks apply to the backend calls inside;
     * the render itself is never mocked.
     */
    async traceRender(page, render) {
        const options = typeof page === 'string' ? { path: page } : page;
        const incoming = options.headers ?? null;
        const headerSession = safeId(incoming?.get('x-qa-session-id') ?? null);
        const sessionId = headerSession ?? (this.options.captureWithoutSession ? exports.AMBIENT_SESSION_ID : undefined);
        // Nested renders (a layout and its page, say) stay one page call.
        if (!this.enabled || !sessionId || this.contexts.getStore())
            return render();
        const url = renderUrl(options.path, incoming);
        if (!this.originAllowed(url))
            return render();
        this.installFetch();
        const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(incoming?.get('traceparent') ?? '');
        const validParent = parent && !/^0+$/.test(parent[1]) && !/^0+$/.test(parent[2]) ? parent : null;
        const relayTo = this.relayTarget(url);
        if (relayTo)
            await this.pullRules(relayTo);
        const ctx = { sessionId, scenarioId: safeId(incoming?.get('x-test-scenario-id') ?? null), traceId: validParent?.[1] ?? id(16), spanId: id(8), relayTo };
        const method = (options.method ?? 'GET').toUpperCase();
        const startedAt = Date.now();
        return this.contexts.run(ctx, async () => {
            let statusCode = 200;
            let error = null;
            let result;
            let record = true;
            try {
                result = await render();
                return result;
            }
            catch (cause) {
                const digest = typeof cause?.digest === 'string' ? cause.digest : '';
                if (digest.startsWith('NEXT_REDIRECT'))
                    statusCode = 307;
                else if (digest === 'NEXT_NOT_FOUND')
                    statusCode = 404;
                else if (digest === 'DYNAMIC_SERVER_USAGE' || digest.startsWith('NEXT_'))
                    record = false;
                else {
                    statusCode = 500;
                    error = cause instanceof Error ? cause.name : 'RenderError';
                }
                throw cause;
            }
            finally {
                if (record) {
                    const responseCapture = this.bodyCapture.response && isPlainData(result)
                        ? (0, bodies_1.captureMessageBody)(new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } }), this.bodyCapture)
                        : null;
                    this.track(this.finishRecord({
                        ctx, spanId: ctx.spanId, parentSpanId: validParent?.[2] ?? null, kind: 'server', method, url, startedAt,
                        statusCode, requestHeaders: incoming ? new Headers(incoming) : new Headers(), responseHeaders: null,
                        error, requestCapture: null, responseCapture, mockedBy: null, skipped: [],
                    }));
                }
            }
        });
    }
    /**
     * Wraps every HTTP export of a route module at once.
     *
     * Hand-wrapping dozens of routes is where instrumentation coverage silently
     * goes missing, so this keeps a route file to a single line.
     */
    wrapRouteModule(handlers) {
        const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        const wrapped = { ...handlers };
        for (const verb of verbs) {
            const handler = handlers[verb];
            if (typeof handler === 'function') {
                wrapped[verb] = this.wrapRoute(handler);
            }
        }
        return wrapped;
    }
    originAllowed(url) {
        if (this.allowAnyOrigin)
            return true;
        try {
            return this.allowed.has(new URL(url).origin);
        }
        catch {
            return false;
        }
    }
    async decide(kind, method, url, headers, ctx, requestCapture) {
        const active = this.rules.filter((rule) => rule.enabled);
        if (active.length === 0)
            return { rule: null, skipped: [] };
        // The body is only materialised when a rule actually needs it.
        const needsBody = active.some((rule) => Boolean(rule.match.bodyContains));
        const bodyText = needsBody ? (await (0, bodies_1.settleCapture)(requestCapture, 1_000)).body?.content ?? null : null;
        const decision = (0, mocks_1.selectMockRule)(this.rules, { kind, method, url, headers, bodyText, sessionId: ctx.sessionId });
        if (decision.rule) {
            decision.rule.appliedCount += 1;
            // The rules live in the process the extension talks to; its budget must count this use too.
            if (ctx.relayTo)
                this.track(this.relayPost(ctx.relayTo, 'consume', { ruleIds: [decision.rule.id] }));
        }
        return decision;
    }
    async serveMock(rule, skipped, ctx, spanId, method, url, headers, startedAt, requestCapture, signal, fallback) {
        const parentSpanId = ctx.spanId === spanId ? null : ctx.spanId;
        const kind = ctx.spanId === spanId ? 'server' : 'client';
        let response;
        let mockedBy = rule.name;
        try {
            response = await (0, mocks_1.buildMockResponse)(rule, signal);
        }
        catch (cause) {
            const intentional = cause instanceof mocks_1.MockNetworkError || (cause instanceof Error && cause.name === 'AbortError');
            if (intentional) {
                this.track(this.finishRecord({
                    ctx, spanId, parentSpanId, kind, method, url, startedAt,
                    statusCode: null, requestHeaders: headers, responseHeaders: null,
                    error: cause instanceof mocks_1.MockNetworkError ? `Simulated by "${cause.ruleName}"` : 'AbortError',
                    requestCapture, responseCapture: null, mockedBy: rule.name, skipped,
                }));
                throw cause;
            }
            // A malformed rule must degrade to the real behaviour, never break the app.
            mockedBy = null;
            try {
                response = await fallback();
            }
            catch (fallbackCause) {
                this.track(this.finishRecord({
                    ctx, spanId, parentSpanId, kind, method, url, startedAt,
                    statusCode: null, requestHeaders: headers, responseHeaders: null,
                    error: fallbackCause instanceof Error ? fallbackCause.name : 'FetchError',
                    requestCapture, responseCapture: null, mockedBy: null, skipped,
                }));
                throw fallbackCause;
            }
        }
        const responseCapture = this.bodyCapture.response ? (0, bodies_1.captureMessageBody)(response, this.bodyCapture) : null;
        this.track(this.finishRecord({
            ctx, spanId, parentSpanId, kind, method, url, startedAt,
            statusCode: response.status, requestHeaders: headers, responseHeaders: response.headers,
            error: null, requestCapture, responseCapture, mockedBy, skipped,
        }));
        return response;
    }
    /**
     * Rewrites a real upstream response for a `passthrough-mutate` rule.
     *
     * Reads the real body, applies the mutations and hands back a fresh
     * Response; on any failure the untouched original is returned so a broken
     * rule can never break the application.
     */
    async mutatePassthrough(rule, skipped, response, ctx, spanId, method, url, headers, startedAt, requestCapture) {
        let mutated = response;
        let mockedBy = null;
        try {
            const original = await response.clone().text();
            const next = (0, mocks_1.applyFieldMutations)(original, rule.action.fieldMutations ?? []);
            if (next !== original) {
                const nextHeaders = new Headers(response.headers);
                nextHeaders.delete('content-length');
                nextHeaders.delete('content-encoding');
                nextHeaders.set('x-apilens-mock', (0, mocks_1.headerSafe)(rule.name));
                for (const [name, value] of Object.entries(rule.action.headers ?? {})) {
                    try {
                        nextHeaders.set(name, (0, mocks_1.headerSafe)(String(value)));
                    }
                    catch {
                        // Skip a header the platform rejects rather than failing the call.
                    }
                }
                mutated = new Response(next, {
                    status: rule.action.statusCode ?? response.status,
                    statusText: rule.action.statusText ? (0, mocks_1.headerSafe)(rule.action.statusText) : response.statusText,
                    headers: nextHeaders,
                });
                mockedBy = rule.name;
            }
        }
        catch {
            mutated = response;
        }
        const responseCapture = this.bodyCapture.response ? (0, bodies_1.captureMessageBody)(mutated, this.bodyCapture) : null;
        this.track(this.finishRecord({
            ctx, spanId, parentSpanId: ctx.spanId, kind: 'client', method, url, startedAt,
            statusCode: mutated.status, requestHeaders: headers, responseHeaders: mutated.headers,
            error: null, requestCapture, responseCapture, mockedBy, skipped,
        }));
        return mutated;
    }
    track(promise) {
        this.pendingRecords.add(promise);
        void promise.finally(() => this.pendingRecords.delete(promise));
    }
    async finishRecord(input) {
        if (!this.enabled)
            return;
        const endedAt = Date.now();
        const [request, response] = await Promise.all([
            (0, bodies_1.settleCapture)(input.requestCapture, 5_000),
            (0, bodies_1.settleCapture)(input.responseCapture, 5_000),
        ]);
        const bodySettledAt = Date.now();
        const parts = (0, redaction_1.safeUrlParts)(input.url);
        const requestHeaders = (0, redaction_1.redactHeaders)(input.requestHeaders);
        const responseHeaders = (0, redaction_1.redactHeaders)(input.responseHeaders);
        const status = input.error || (input.statusCode ?? 0) >= 400 ? 'error' : 'ok';
        const call = {
            spanId: input.spanId,
            traceId: input.ctx.traceId,
            parentSpanId: input.parentSpanId,
            sessionId: input.ctx.sessionId,
            scenarioId: input.ctx.scenarioId ?? null,
            serviceName: this.options.serviceName,
            kind: input.kind,
            method: input.method,
            url: parts.url,
            origin: parts.origin,
            path: parts.path,
            query: parts.query,
            statusCode: input.statusCode,
            status,
            startedAt: input.startedAt,
            endedAt,
            durationMs: endedAt - input.startedAt,
            bodyDurationMs: response.body ? bodySettledAt - input.startedAt : null,
            requestHeaders,
            responseHeaders,
            requestBody: request.body,
            responseBody: response.body,
            requestBodyOmitted: request.omitted,
            responseBodyOmitted: response.omitted,
            error: input.error,
            mockedBy: input.mockedBy,
        };
        if (input.ctx.relayTo)
            await this.relayPost(input.ctx.relayTo, 'ingest', { calls: [call] });
        else
            this.buffer.add(call);
        this.reporter.add({
            traceId: call.traceId, spanId: call.spanId, parentSpanId: call.parentSpanId, sessionId: call.sessionId,
            serviceName: call.serviceName, operationName: `${call.method} ${call.url}`, kind: call.kind,
            source: 'internal-service', channel: 'server-sdk', method: call.method, url: call.url,
            statusCode: call.statusCode, status, startedAt: call.startedAt, endedAt: call.endedAt,
            durationMs: call.durationMs,
            attributes: {
                requestHeaders: JSON.stringify(requestHeaders),
                responseHeaders: JSON.stringify(responseHeaders),
                scenario: input.ctx.scenarioId ?? '',
                timingScope: response.body ? 'response-body' : 'response-headers',
                bodyCapture: Boolean(request.body || response.body),
                requestBody: serialiseBody(request.body),
                responseBody: serialiseBody(response.body),
                requestBodyOmitted: request.omitted ?? '',
                responseBodyOmitted: response.omitted ?? '',
                mockSkipped: input.skipped.length ? JSON.stringify(input.skipped.slice(0, 10)) : '',
            },
            events: [],
            error: input.error,
            mockedBy: input.mockedBy,
        });
    }
    /**
     * Where this process should forward captures, or null to keep them.
     *
     * Only processes that have not answered the extension relay: on Vercel the
     * API function hosting the control route becomes the store, and page
     * functions forward to it.
     */
    relayTarget(requestUrl) {
        const relay = this.options.control?.enabled ? this.options.control.relay : undefined;
        if (!relay || this.servedControl)
            return null;
        if (relay.url)
            return relay.url.replace(/\/$/, '');
        try {
            return `${new URL(requestUrl).origin}/api/__apilens`;
        }
        catch {
            return null;
        }
    }
    async relayRequest(base, operation, init) {
        const relay = this.options.control?.relay;
        try {
            // insideFetch keeps the SDK's own traffic out of the capture.
            const response = await this.insideFetch.run(true, () => fetch(`${base}/${operation}`, {
                ...init,
                cache: 'no-store',
                signal: AbortSignal.timeout(relay?.timeoutMs ?? 3_000),
                headers: {
                    ...(relay?.headers ?? {}),
                    authorization: `Bearer ${this.options.control?.token ?? ''}`,
                    'content-type': 'application/json',
                },
            }));
            if (!response.ok)
                throw new Error(`HTTP ${response.status}`);
            return response;
        }
        catch (cause) {
            this.relayFailures += 1;
            this.lastRelayError = `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`;
            return null;
        }
    }
    async relayPost(base, operation, payload) {
        await this.relayRequest(base, operation, { method: 'POST', body: JSON.stringify(payload) });
    }
    /** Refreshes the mock rules from the relay target; keeps the last copy if it cannot. */
    async pullRules(base) {
        const response = await this.relayRequest(base, 'rules', { method: 'GET' });
        const payload = response ? (await response.json().catch(() => null)) : null;
        if (Array.isArray(payload?.rules))
            this.setServerMockRules(payload.rules);
    }
    ingestRelayed(calls) {
        let kept = 0;
        for (const raw of calls) {
            const call = relayedCall(raw);
            if (call) {
                this.buffer.add(call);
                kept += 1;
            }
        }
        return kept;
    }
    /** Drains pending captures, then delivers queued spans to the agent. */
    async flush() {
        while (this.pendingRecords.size > 0)
            await Promise.allSettled([...this.pendingRecords]);
        await this.reporter.flush();
    }
    async shutdown() {
        await this.flush();
        this.stopped = true;
        if (globalThis.fetch === this.wrapper && this.downstream)
            globalThis.fetch = this.downstream;
        await this.reporter.shutdown();
    }
}
exports.ApiLensNextSDK = ApiLensNextSDK;
/** Validates a call relayed by another process; anything malformed is dropped. */
function relayedCall(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const value = raw;
    const text = (key, max = 4_096) => (typeof value[key] === 'string' ? value[key].slice(0, max) : null);
    const num = (key) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : null);
    const record = (key) => {
        const entry = value[key];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return {};
        return Object.fromEntries(Object.entries(entry).filter(([, item]) => typeof item === 'string').slice(0, 200));
    };
    const body = (key) => {
        const entry = value[key];
        return entry && typeof entry === 'object' && typeof entry.content === 'string' ? entry : null;
    };
    const kind = value.kind === 'server' || value.kind === 'client' ? value.kind : null;
    const spanId = text('spanId', 64);
    const traceId = text('traceId', 64);
    const startedAt = num('startedAt');
    const endedAt = num('endedAt');
    if (!kind || !spanId || !traceId || startedAt === null || endedAt === null)
        return null;
    return {
        spanId, traceId, kind, startedAt, endedAt,
        parentSpanId: text('parentSpanId', 64),
        sessionId: text('sessionId', 128) ?? exports.AMBIENT_SESSION_ID,
        scenarioId: text('scenarioId', 128),
        serviceName: text('serviceName', 200) ?? 'unknown',
        method: (text('method', 16) ?? 'GET').toUpperCase(),
        url: text('url') ?? '',
        origin: text('origin') ?? '',
        path: text('path') ?? '',
        query: record('query'),
        statusCode: num('statusCode'),
        status: value.status === 'error' ? 'error' : 'ok',
        durationMs: num('durationMs') ?? endedAt - startedAt,
        bodyDurationMs: num('bodyDurationMs'),
        requestHeaders: record('requestHeaders'),
        responseHeaders: record('responseHeaders'),
        requestBody: body('requestBody'),
        responseBody: body('responseBody'),
        requestBodyOmitted: text('requestBodyOmitted', 500),
        responseBodyOmitted: text('responseBodyOmitted', 500),
        error: text('error', 500),
        mockedBy: text('mockedBy', 500),
    };
}
/** Absolute URL for a rendered page, from the forwarded host when there is one. */
function renderUrl(path, headers) {
    const pathPart = path.startsWith('/') ? path : `/${path}`;
    const forwarded = headers?.get('x-forwarded-host')?.split(',')[0]?.trim();
    const candidate = forwarded || headers?.get('host') || 'localhost';
    const host = /^[a-zA-Z0-9.\-[\]:]{1,255}$/.test(candidate) ? candidate : 'localhost';
    const proto = headers?.get('x-forwarded-proto')?.split(',')[0]?.trim()
        ?? (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https');
    try {
        return new URL(pathPart, `${proto === 'http' ? 'http' : 'https'}://${host}`).toString();
    }
    catch {
        return `http://localhost${pathPart}`;
    }
}
/** Data a page loaded (JSON-safe), as opposed to rendered React output. */
function isPlainData(value) {
    if (Array.isArray(value))
        return true;
    if (!value || typeof value !== 'object' || '$$typeof' in value)
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function serialiseBody(body) {
    return body ? JSON.stringify(body) : '';
}
//# sourceMappingURL=index.js.map