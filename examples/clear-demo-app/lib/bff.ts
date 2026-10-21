import { apiLens } from './apilens';
import { BackendError, isValidContactId, loadAmountDue, loadBillHistory, loadNextBill } from './billing';
import { DEFAULT_CONTACT_ID } from './demo-data';

/**
 * The BFF endpoints the browser calls — used by the Dashboard, which loads
 * its data in the browser (the billing page instead loads on the server):
 *
 *   GET /api/billing/amount-due?contactId=…  → balance service
 *   GET /api/billing/next-bill?contactId=…   → billing service
 *   GET /api/billing/history?contactId=…     → invoices service
 *
 * Wrapped with the SDK, so ApiLens shows each as a page call with its backend
 * call underneath, and server mocks can change what the backend answers.
 */

export function servicesBase(origin: string): string {
  return process.env.SERVICES_BASE_URL ?? origin;
}

function endpoint<T>(load: (base: string, contactId: string) => Promise<T>) {
  return apiLens.wrapRoute(async (request: Request) => {
    const url = new URL(request.url);
    const contactId = url.searchParams.get('contactId') ?? DEFAULT_CONTACT_ID;
    if (!isValidContactId(contactId)) return Response.json({ error: 'contactId must be digits only' }, { status: 400 });
    try {
      return Response.json(await load(servicesBase(url.origin), contactId), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof BackendError) {
        return Response.json({ error: error.message, upstreamStatus: error.status }, { status: error.status >= 500 ? error.status : 502 });
      }
      return Response.json({ error: 'Something went wrong on the server.' }, { status: 500 });
    }
  });
}

const ROUTES: Record<string, (request: Request, context: unknown) => Promise<Response>> = {
  'amount-due': endpoint(loadAmountDue),
  'next-bill': endpoint(loadNextBill),
  history: endpoint(loadBillHistory),
};

export function bff(method: string, segments: string[], request: Request): Promise<Response> | Response {
  const handler = segments.length === 1 ? ROUTES[segments[0]!] : undefined;
  if (!handler) return Response.json({ error: 'Not found' }, { status: 404 });
  if (method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
  return handler(request, undefined);
}
