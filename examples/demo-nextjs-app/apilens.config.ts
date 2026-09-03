import { ApiLensSDK } from '@apilens/node-sdk';

const sdk = new ApiLensSDK({
  serviceName: 'demo-nextjs-frontend',
  reporterUrl: process.env.APILENS_REPORTER_URL || 'http://127.0.0.1:7317',
  enabled: process.env.APILENS_ENABLED !== 'false',
});

export default sdk;
