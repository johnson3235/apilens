import { ApiLensNextSDK } from '@apilens/next-sdk';

// Server-only: import from route handlers and instrumentation, never from pages.
const processState = globalThis as typeof globalThis & {
  __demoApiLens?: ApiLensNextSDK;
};

export const apiLens = (processState.__demoApiLens ??= new ApiLensNextSDK({
  serviceName: 'demo-nextjs-bff',
  enabled: process.env.APILENS_ENABLED === 'true',
  reportToAgent: false,
  allowedAppOrigins: ['*'],
  captureWithoutSession: true,
  captureBodies: {
    request: true,
    response: true,
    maxBytes: 64 * 1024,
    redactKeys: ['cardNumber', 'cvv'],
  },
  control: {
    enabled: true,
    token: process.env.APILENS_CONTROL_TOKEN ?? '',
    bufferSize: 500,
  },
}));
