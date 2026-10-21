import { balanceFor, invoicesFor, nextBillFor } from './demo-data';

/**
 * The fake backend services the BFF calls server-side.
 *
 * They live in this app so one Vercel deployment is the whole demo, but they
 * stand in for separate systems: the browser never calls them, and they are
 * deliberately not wrapped by the SDK, so they show up only as the backend
 * calls the BFF makes.
 *
 *   GET /api/services/balance/:contactId    outstanding balance (amount due)
 *   GET /api/services/billing/:contactId    next bill
 *   GET /api/services/invoices/:contactId   bill history
 *
 * Paths are kept short so they read in full in the ApiLens panel.
 */

const SERVICES: Record<string, { latencyMs: number; build: (contactId: string) => unknown }> = {
  balance: { latencyMs: 180, build: balanceFor },
  billing: { latencyMs: 240, build: nextBillFor },
  invoices: { latencyMs: 320, build: invoicesFor },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function services(method: string, segments: string[]): Promise<Response> {
  const [name, contactId, ...extra] = segments;
  const service = name ? SERVICES[name] : undefined;
  if (!service || !contactId || extra.length) {
    return Response.json({ error: 'Unknown service endpoint' }, { status: 404 });
  }
  if (method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  if (!/^\d{1,12}$/.test(contactId)) return Response.json({ error: 'Invalid contactId' }, { status: 400 });

  await sleep(service.latencyMs);
  return Response.json(service.build(contactId), {
    headers: { 'cache-control': 'no-store', 'x-service-name': `${name}-service` },
  });
}
