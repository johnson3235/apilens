import { ApiLensNextSDK } from '@apilens/next-sdk';

// Server-only: import from route handlers and instrumentation, never from pages.

const token = process.env.APILENS_CONTROL_TOKEN ?? '';
const requested = process.env.APILENS_ENABLED === 'true';
// The SDK refuses short tokens; stay off rather than crash the whole app.
const enabled = requested && token.length >= 24;

if (requested && !enabled) {
  console.warn('[apilens] APILENS_ENABLED is true but APILENS_CONTROL_TOKEN is missing or shorter than 24 characters; the SDK stays off.');
}

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
    enabled,
    token,
    bufferSize: 500,
    relay,
  },
}));
