# Setup Guide

## Prerequisites
- Node.js 20+
- pnpm 9+
- Docker
- Chrome Browser

## Quick Start with Docker Compose
To start the entire environment with a single command:
```bash
cd infrastructure/docker
docker-compose up -d
```

## Manual Development Setup
1. **Install Dependencies:**
   ```bash
   pnpm install
   ```
2. **Database Setup:**
   Make sure Postgres and Redis are running locally, then push the schema:
   ```bash
   cd apps/control-plane-api
   pnpm prisma db push
   ```
3. **Start Services:**
   Run the dev command from the root:
   ```bash
   pnpm dev
   ```

## Loading the Chrome Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in the top right).
3. Click "Load unpacked".
4. Select the `apps/browser-extension/dist` folder in the ApiLens project directory.

## Running the Demo Scenario
1. **Start all services** (via Docker Compose or manually).
2. **Load the extension** in Chrome as described above.
3. Open `http://localhost:3000` in Chrome.
4. Open Chrome DevTools and navigate to the **ApiLens** panel.
5. Watch the browser requests appear as you interact with the page.
6. Navigate to `/checkout` to see server-side rendering (SSR) calls.
7. **Create a scenario:** In the extension, mock the `POST /api/payments` endpoint to return a `503 Service Unavailable`.
8. Click "Pay" on the checkout page and observe the failure gracefully handled.
9. View the unified timeline showing both the client and server traces.
10. Export the scenario as Playwright code for automated tests.

## Architecture Overview
ApiLens consists of a browser extension, a control plane API, a real-time gateway, and SDKs (Node.js/Python) that work together to trace and mock full-stack requests in a unified manner.

## Troubleshooting
- **Extension not showing requests?** Make sure DevTools is open and the ApiLens panel is active.
- **Trace not appearing?** Verify `APILENS_REPORTER_URL` is configured properly.
