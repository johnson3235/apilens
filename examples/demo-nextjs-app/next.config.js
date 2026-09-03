/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone tracing creates symlinks and is needed only for the container
  // image. Ordinary Windows development/builds use the standard output.
  output: process.env.APILENS_STANDALONE === '1' ? 'standalone' : undefined,
  experimental: {
    instrumentationHook: true
  }
};

module.exports = nextConfig;
