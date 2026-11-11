/**
 * Edge middleware capture, `@apilens/next-sdk/edge`.
 *
 * Next 14 runs `middleware.ts` in its Edge sandbox, with its own `fetch` and
 * no Node `http`, so the Node hooks of the main entry never see the calls it
 * makes: session lookups, journey bootstrap, account checks. This entry wraps
 * the middleware function instead, records those calls inside the sandbox and
 * posts them to the app's own control plane (`/api/__apilens/ingest`), where
 * they appear next to the page and route calls in the extension.
 *
 * It imports nothing from Node, so it is safe to bundle into Edge code.
 */
export interface EdgeCaptureOptions {
    /** Explicit opt-in, normally `process.env.APILENS_ENABLED === 'true'`. Default false. */
    enabled?: boolean;
    serviceName?: string;
    /** The same APILENS_CONTROL_TOKEN the Node SDK uses; at least 24 characters. */
    controlToken?: string;
    /**
     * Control endpoint to deliver to. Default `<request origin>/api/__apilens`.
     * Behind a load balancer, point it at the pod itself, for example
     * `http://127.0.0.1:${process.env.PORT}/api/__apilens`.
     */
    ingestUrl?: string;
    /** Record middleware runs with no QA session header. Default false. */
    captureWithoutSession?: boolean;
    /** Capture request/response payloads of the middleware's calls. Default true, 32 KB each. */
    captureBodies?: {
        request?: boolean;
        response?: boolean;
        maxBytes?: number;
        redactKeys?: string[];
    };
    /** Outgoing calls never captured; same forms as the Node SDK's `ignoreOutgoing`. */
    ignoreOutgoing?: (string | RegExp)[];
    /** Record runs that made no backend call and did not redirect or fail. Default false. */
    recordAllRequests?: boolean;
}
type Middleware<Req extends Request, Evt, Res> = (request: Req, event: Evt) => Res | Promise<Res>;
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
export declare function withApiLens<Req extends Request, Evt, Res>(middleware: Middleware<Req, Evt, Res>, options: EdgeCaptureOptions): Middleware<Req, Evt, Res>;
export {};
//# sourceMappingURL=edge.d.ts.map