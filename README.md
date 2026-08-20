# ApiLens 🔍

The ultimate full-stack observability and testing platform. Trace, mock, and export scenarios across frontend and backend environments instantly.

## Key Features
- **Unified Tracing:** View full-stack requests (client, SSR, backend) in a single DevTools panel.
- **Dynamic Mocking:** Force page `fetch`/XHR outcomes from the extension, with opt-in SDK middleware for controlled server-side services.
- **Scenario Export:** Easily export recorded traces into Playwright or Cypress test scripts.
- **Zero Overhead:** SDKs are completely dormant in production unless explicit QA headers are present.

## Quick Start
Check out the [Setup Guide](docs/SETUP.md) for detailed instructions on getting started with Docker Compose or local development.

## Architecture
ApiLens uses a Browser Extension for client-side interception, SDKs for backend tracing, and a real-time Control Plane to bridge them together securely.

## Project Structure
- `apps/`
  - `browser-extension`: Brave, Chrome, Edge, Firefox, and Safari DevTools extension.
  - `control-plane-api`: Core backend for tracing and config.
  - `realtime-gateway`: WebSocket gateway for live updates.
- `sdks/`
  - `node`: Express & Node.js SDK.
- `examples/`
  - `demo-nextjs-app`: Next.js frontend demo.
  - `demo-api-server`: Backend Express demo.
- `packages/`
  - `shared-types`: Types shared across the monorepo.
- `infrastructure/`
  - `docker`: Dockerfiles and Compose configurations.

## Development
Run the whole stack locally:
```bash
pnpm install
pnpm build
pnpm dev
```

## Contributing
Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License
MIT
