import { ApiLensNextSDK } from '@apilens/next-sdk';

// Server-only: import from route handlers and instrumentation, never from pages.

// A missing or short token no longer stops the app: the SDK switches the
// control plane off and reports why (`apiLens.diagnostics.configIssues`).
const enabled = process.env.APILENS_ENABLED === 'true';

// Vercel runs the billing page and the API route as separate functions with
// separate memory. Relay lets the page function hand its captured calls to the
// API function that the extension polls (and read the mock rules from it).
// APILENS_RELAY=true forces it on elsewhere, e.g. to try it locally.
const relay = process.env.VERCEL === '1' || process.env.APILENS_RELAY === 'true'
  ? {
      headers: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
        : undefined,
    }
  : undefined;

const processState = globalThis as typeof globalThis & { __clearDemoApiLens?: ApiLensNextSDK };

export const apiLens = (processState.__clearDemoApiLens ??= new ApiLensNextSDK({
  serviceName: 'clear-demo-bff',
  enabled,
  reportToAgent: false,
  allowedAppOrigins: ['*'],
  captureWithoutSession: true,
  captureBodies: {
    request: true,
    response: true,
    maxBytes: 64 * 1024,
    redactKeys: ['iban', 'cardNumber'],
  },
  control: {
    enabled: true,
    token: process.env.APILENS_CONTROL_TOKEN ?? '',
    bufferSize: 500,
    // Keeps a pod's capture memory bounded on a busy dev server.
    maxBufferBytes: 32 * 1024 * 1024,
    relay,
  },
  // Every request is captured automatically. The fake services stand in for
  // separate systems, so they show only as the backend calls the app makes.
  autoInstrument: { ignorePaths: ['/api/services/'] },
}));
