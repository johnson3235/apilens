# CLEAR Demo — My Account (dummy app for ApiLens)

A small Next.js app that looks like a My Account portal, with dummy data, built to demo the
ApiLens extension live. It shows **both** ways a page can get its data, side by side:

| Page | Loads its data | What ApiLens shows |
|---|---|---|
| `/myaccount` (Dashboard): amount due **€80.00**, next bill **€12.99**, account tiles | **in the browser** | **Network:** 2 browser calls (`/api/billing/amount-due`, `/api/billing/next-bill`). **Server API:** each one with the backend call it caused |
| `/myaccount/billing?contactId=3055861`: amount due, next bill breakdown, bill history | **on the server** (Server Component), like the real CLEAR feature | **Network: 0 API calls.** **Server API:** `GET /myaccount/billing` with its 3 backend calls underneath |

Each page shows a small badge, "Loaded in the browser" or "Loaded on the server", so the audience can follow.

The three backend calls behind billing:

| Backend call (server → service) | Answer |
|---|---|
| `GET /api/services/balance/3055861` | outstanding balance €80.00, due 28 Oct |
| `GET /api/services/billing/3055861` | next bill €12.99 (plan 9.99 + roaming 3.00) |
| `GET /api/services/invoices/3055861` | 6 invoices, 2 unpaid |

**Failure handling.** If one backend fails, only its card shows "We couldn't load this right now", with the HTTP status and a **Try again** button. The other cards keep working, and that is what QA checks when they simulate a problem. On the billing page, *Try again* and *Refresh* reload the whole page, so retries stay server-side too. Every in-app link is a plain link, because Next.js `<Link>` prefetches would show up in Network as fetches.

## How it is wired

- **`lib/apilens.ts`**: the SDK singleton. It is on only when `APILENS_ENABLED=true` and the token has 24+ characters.
- **`app/myaccount/billing/page.tsx`**: the server-rendered page. Its data loading runs inside `apiLens.traceRender(...)`, so the render becomes a page call and its fetches become backend calls.
- **`app/api/[...path]/route.ts`**: one route for every API path:
  - `/api/__apilens/*`: the ApiLens control endpoint, token-protected
  - `/api/billing/*`: the BFF the Dashboard calls, wrapped with `wrapRoute`
  - `/api/services/*`: the dummy backend services
- **Relay**: on Vercel the billing page and the API route run as **separate functions with separate memory**. The SDK's `control.relay` (on automatically when `VERCEL=1`) makes the page function send its captured calls to the API function the extension polls, and read the mock rules from it.

The dummy services run inside this same app, so a single deployment is the whole demo.

## Run locally

```bash
npm install
cp .env.example .env.local   # then put a 24+ character token in APILENS_CONTROL_TOKEN
npm run dev                  # http://localhost:3000/myaccount
```

## Deploy to Vercel

1. **Push the repo to GitHub.** `vendor/apilens-next-sdk/lib` must be committed, because it is the SDK.
2. **Import the project in Vercel** → **Add New… → Project**. Then:
   - **Root Directory:** `examples/clear-demo-app`
   - **Framework:** Next.js
   - **Install / build commands:** leave as default
3. **Project name:** include `dev`, for example `clear-demo-dev`. The URL `clear-demo-dev.vercel.app` is then recognised by the extension as a *dev* environment, so browser mocks are allowed. Otherwise, add the host in the extension's **Settings → Environments**.
4. **Environment Variables:**
   - `APILENS_ENABLED` = `true`
   - `APILENS_CONTROL_TOKEN` = a random string of 24+ characters. Generate one with:
     `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
5. **Deploy.** Then open `https://<project>.vercel.app/myaccount`.
6. **Use the production URL** (`<project>.vercel.app`) in the meeting, not a preview URL. Preview URLs have Vercel login protection, which blocks the server calling itself (backend services and relay). If you need a protected URL anyway, enable *Protection Bypass for Automation*. The app forwards `VERCEL_AUTOMATION_BYPASS_SECRET` automatically.

Without the two variables the app still works; ApiLens server capture is simply off.

## Check it before the meeting

```bash
node scripts/check-live.mjs https://<project>.vercel.app <APILENS_CONTROL_TOKEN>
```

The script:

1. Loads the server-rendered billing page.
2. Checks that ApiLens captured it as a page call with 3 linked backend calls.
3. Proves a one-shot "Service is down" mock breaks only the Next bill card, and only once.
4. Removes the mock and checks the Dashboard endpoints.

It ends with `Ready for the demo.`

## Demo script (≈6 minutes)

1. **Connect the extension.** Open the extension panel (DevTools → ApiLens). Go to **Settings → Instrumented server** and enter:
   - the app address (`https://<project>.vercel.app`)
   - the token
2. **Start on the Dashboard**, marked "Loaded in the browser". Open **Network**: the 2 browser calls are there.
3. **Open the billing page.** Click **View next bill**; the page is marked "Loaded on the server". **Network shows no new API calls**, so the browser never saw them.
4. **Show the server side.** Open **Server API**: `GET /myaccount/billing` is listed with its 3 backend calls. Click `/api/services/billing/3055861` → **Received** to show the real backend answer.
5. **Simulate a problem.** Click **Simulate a problem** → **Service is down** → **Only the next call** → **Save and turn on**.
6. **Show the failure.** Click **Refresh** on the billing page:
   - **Next bill** shows the friendly error with HTTP 503.
   - Amount due and history still load.
   - In ApiLens the call is tagged **mock**.
7. **Show it recover.** Click **Try again**: €12.99 is back, because the mock was one-shot.

## Notes

- **Cold starts.** Captured calls live in server memory. After a cold start (first visit, or a long idle), the list starts empty. Just use the page again.
- **Updating the SDK.** To refresh the bundled SDK from this monorepo:
  1. `pnpm --filter @apilens/next-sdk build`
  2. `npm run sdk:sync`
  3. `npm install`
- **Not a pnpm workspace member.** This folder is excluded from the pnpm workspace on purpose (it uses npm and its own `package-lock.json`), so it can be deployed on its own.
