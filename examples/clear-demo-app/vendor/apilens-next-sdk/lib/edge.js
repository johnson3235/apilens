"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withApiLens = withApiLens;
const redaction_1 = require("./redaction");
const types_1 = require("./types");
const AMBIENT_SESSION_ID = 'apilens-ambient';
const MAX_BATCH = 50;
const MIN_TOKEN_LENGTH = 24;
const FETCH_KEY = Symbol.for('apilens.next.edgeFetch');
const STORE_KEY = Symbol.for('apilens.next.edgeStore');
const SETTLE_TIMEOUT_MS = 3_000;
const hex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const safeId = (value) => value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
/** Next's Edge runtime exposes AsyncLocalStorage globally; without it, overlapping runs share the latest one. */
function createStore() {
    const Ctor = globalThis.AsyncLocalStorage;
    if (Ctor)
        return new Ctor();
    let current;
    return {
        getStore: () => current,
        run: (store, fn) => { current = store; try {
            return fn();
        }
        finally { /* kept until the next run starts */ } },
    };
}
function matcher(rules) {
    return (raw) => {
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            return false;
        }
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        return rules.some((rule) => {
            if (rule instanceof RegExp) {
                rule.lastIndex = 0;
                return rule.test(raw);
            }
            const value = rule.trim().toLowerCase();
            if (!value)
                return false;
            if (value.includes('://'))
                return raw.toLowerCase().startsWith(value);
            if (value.startsWith(':'))
                return port === value.slice(1);
            if (value.includes(':'))
                return `${url.hostname}:${port}`.toLowerCase() === value;
            return url.hostname.toLowerCase() === value || url.hostname.toLowerCase().endsWith(`.${value}`);
        });
    };
}
async function capture(source, text, contentType, maxBytes, redactKeys) {
    try {
        const raw = text ?? (source && source.body ? await source.clone().text() : null);
        if (raw === null || raw === '')
            return { body: null, omitted: null };
        if (contentType && !/json|text|xml|form-urlencoded|graphql|javascript/i.test(contentType)) {
            return { body: null, omitted: `Not captured: ${contentType.split(';')[0]} is not text` };
        }
        const truncated = raw.length > maxBytes;
        const redacted = (0, redaction_1.redactBody)(truncated ? raw.slice(0, maxBytes) : raw, contentType, redactKeys);
        return {
            body: { content: redacted.text, encoding: 'utf8', contentType, byteLength: Math.min(raw.length, maxBytes), truncated, redacted: redacted.redacted },
            omitted: null,
        };
    }
    catch {
        return { body: null, omitted: 'Not captured: body could not be read' };
    }
}
function record(input) {
    const endedAt = Date.now();
    const parts = (0, redaction_1.safeUrlParts)(input.url);
    return {
        spanId: input.spanId, traceId: input.run.traceId, parentSpanId: input.parentSpanId, sessionId: input.run.sessionId,
        scenarioId: null, serviceName: input.serviceName, kind: input.kind, method: input.method,
        url: parts.url, origin: parts.origin, path: parts.path, query: parts.query,
        statusCode: input.statusCode, status: input.error || (input.statusCode ?? 0) >= 400 ? 'error' : 'ok',
        startedAt: input.startedAt, endedAt, durationMs: endedAt - input.startedAt,
        bodyDurationMs: input.response.body ? endedAt - input.startedAt : null,
        requestHeaders: (0, redaction_1.redactHeaders)(input.requestHeaders), responseHeaders: (0, redaction_1.redactHeaders)(input.responseHeaders),
        requestBody: input.request.body, responseBody: input.response.body,
        requestBodyOmitted: input.request.omitted, responseBodyOmitted: input.response.omitted,
        error: input.error, mockedBy: null, stage: 'middleware',
    };
}
/** True when Next will go on to render the page (or a rewrite target) after this middleware response. */
function continuesToApp(response) {
    return response.headers.get('x-middleware-next') === '1' || response.headers.has('x-middleware-rewrite');
}
/**
 * Hands the run's ids to the request Next forwards to the app, through the
 * same response headers `NextResponse.next({ request: { headers } })` sets,
 * so the page's server capture continues this trace.
 */
function linkDownstream(result, request, link) {
    let response;
    if (result === undefined || result === null) {
        // Returning nothing means "continue"; an explicit next() response is equivalent.
        response = new Response(null, { headers: { 'x-middleware-next': '1' } });
    }
    else if (result instanceof Response && continuesToApp(result)) {
        response = result;
    }
    else {
        return result;
    }
    try {
        const headers = response.headers;
        const override = headers.get('x-middleware-override-headers');
        // Without an override list Next keeps the incoming headers; with one it keeps exactly those listed.
        const names = override !== null
            ? override.split(',').map((name) => name.trim()).filter(Boolean)
            : [...request.headers.keys()].filter((name) => !name.startsWith('x-middleware-'));
        if (override === null) {
            for (const name of names)
                headers.set(`x-middleware-request-${name}`, request.headers.get(name) ?? '');
        }
        if (!names.includes(types_1.MIDDLEWARE_HEADER))
            names.push(types_1.MIDDLEWARE_HEADER);
        headers.set(`x-middleware-request-${types_1.MIDDLEWARE_HEADER}`, link);
        headers.set('x-middleware-override-headers', names.join(','));
    }
    catch {
        return result; // Immutable headers (Response.redirect and friends): leave the response as it is.
    }
    return response;
}
/**
 * Wraps a Next.js middleware so the backend calls it makes reach ApiLens.
 *
 *   // src/middleware.ts
 *   import { withApiLens } from '@apilens/next-sdk/edge';
 *   export const middleware = withApiLens(existingMiddleware, {
 *     enabled: process.env.APILENS_ENABLED === 'true',
 *     controlToken: process.env.APILENS_CONTROL_TOKEN,
 *     captureWithoutSession: true,
 *   });
 *
 * Disabled, or without a valid token, it returns the middleware unchanged.
 * Delivery never delays the response: it runs through `event.waitUntil`.
 */
function withApiLens(middleware, options) {
    const token = options.controlToken ?? '';
    if (options.enabled !== true || token.length < MIN_TOKEN_LENGTH)
        return middleware;
    const serviceName = options.serviceName ?? 'next-middleware';
    const maxBytes = Math.max(0, Math.min(options.captureBodies?.maxBytes ?? 32 * 1024, 512 * 1024));
    const captureRequest = options.captureBodies?.request !== false && maxBytes > 0;
    const captureResponse = options.captureBodies?.response !== false && maxBytes > 0;
    const redactKeys = options.captureBodies?.redactKeys ?? [];
    // One store and one fetch patch per sandbox, however many times this is called.
    const shared = globalThis;
    const store = (shared[STORE_KEY] ??= createStore());
    const ignored = matcher([':8126', ':4317', ':4318', ...(options.ignoreOutgoing ?? [])]);
    // The SDK's own delivery uses the saved original, so it is never captured.
    const original = shared[FETCH_KEY] ?? globalThis.fetch;
    if (!shared[FETCH_KEY]) {
        shared[FETCH_KEY] = original;
        globalThis.fetch = async function apiLensEdgeFetch(input, init) {
            const run = store.getStore();
            const url = input instanceof Request ? input.url : String(input);
            if (!run || ignored(url) || url.includes('/__apilens'))
                return original(input, init);
            const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
            const startedAt = Date.now();
            const spanId = hex(8);
            const request = captureRequest
                ? capture(input instanceof Request && init?.body === undefined ? input : null, typeof init?.body === 'string' ? init.body : null, headers.get('content-type'), maxBytes, redactKeys)
                : Promise.resolve({ body: null, omitted: null });
            try {
                const response = await original(input, init);
                const captured = captureResponse ? capture(response, null, response.headers.get('content-type'), maxBytes, redactKeys) : Promise.resolve({ body: null, omitted: null });
                run.pending.push(Promise.all([request, captured]).then(([req, res]) => {
                    run.calls.push(record({
                        run, spanId, parentSpanId: run.spanId, kind: 'client', serviceName, method, url, startedAt,
                        statusCode: response.status, error: null, requestHeaders: headers, responseHeaders: response.headers, request: req, response: res,
                    }));
                }));
                return response;
            }
            catch (cause) {
                run.pending.push(request.then((req) => {
                    run.calls.push(record({
                        run, spanId, parentSpanId: run.spanId, kind: 'client', serviceName, method, url, startedAt,
                        statusCode: null, error: cause instanceof Error ? cause.name : 'FetchError',
                        requestHeaders: headers, responseHeaders: null, request: req, response: { body: null, omitted: null },
                    }));
                }));
                throw cause;
            }
        };
    }
    return async function apiLensMiddleware(request, event) {
        let url;
        try {
            url = new URL(request.url);
        }
        catch {
            return middleware(request, event);
        }
        if (/\/(?:__|%5F_)apilens(?:\/|$)/i.test(url.pathname))
            return middleware(request, event);
        const sessionId = safeId(request.headers.get('x-qa-session-id')) ?? (options.captureWithoutSession ? AMBIENT_SESSION_ID : undefined);
        if (!sessionId)
            return middleware(request, event);
        const parent = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(request.headers.get('traceparent') ?? '');
        const run = { sessionId, traceId: parent?.[1] ?? hex(16), spanId: hex(8), calls: [], pending: [] };
        const startedAt = Date.now();
        let result;
        let error = null;
        try {
            result = await store.run(run, () => middleware(request, event));
            // Only runs that will be recorded are linked, so most requests pass through untouched.
            if (run.pending.length > 0 || options.recordAllRequests === true) {
                return linkDownstream(result, request, `${run.traceId}-${run.spanId}`);
            }
            return result;
        }
        catch (cause) {
            error = cause instanceof Error ? cause.name : 'MiddlewareError';
            throw cause;
        }
        finally {
            const response = result instanceof Response ? result : null;
            const deliver = (async () => {
                // Let the body captures of this run's calls settle first, but never wait unbounded.
                await Promise.race([
                    Promise.allSettled(run.pending),
                    new Promise((resolve) => setTimeout(resolve, SETTLE_TIMEOUT_MS)),
                ]);
                const status = response?.status ?? (error ? 500 : 200);
                const notable = run.calls.length > 0 || error !== null || status >= 300 || options.recordAllRequests === true;
                if (!notable)
                    return;
                const calls = [record({
                        run, spanId: run.spanId, parentSpanId: parent?.[2] ?? null, kind: 'server', serviceName, method: request.method.toUpperCase(),
                        url: request.url, startedAt, statusCode: error ? null : status, error,
                        requestHeaders: request.headers, responseHeaders: response?.headers ?? null,
                        request: { body: null, omitted: 'Middleware request bodies are not read' }, response: { body: null, omitted: null },
                    }), ...run.calls];
                const target = (options.ingestUrl ?? `${url.origin}/api/__apilens`).replace(/\/$/, '');
                for (let index = 0; index < calls.length; index += MAX_BATCH) {
                    await original(`${target}/ingest`, {
                        method: 'POST',
                        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                        body: JSON.stringify({ calls: calls.slice(index, index + MAX_BATCH) }),
                    }).catch(() => undefined);
                }
            })();
            const waitUntil = event?.waitUntil;
            if (typeof waitUntil === 'function')
                waitUntil.call(event, deliver);
            else
                void deliver;
        }
    };
}
//# sourceMappingURL=edge.js.map