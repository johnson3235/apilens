/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Runs instrumentation.ts on server start so the SDK can patch fetch.
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
