import { ApiLensSDK } from '@apilens/node-sdk';

const sdk = new ApiLensSDK({
  serviceName: 'demo-nextjs-frontend',
  reporterUrl: 'http://localhost:3001',
  enabled: process.env.APILENS_ENABLED !== 'false',
});

export default sdk;
