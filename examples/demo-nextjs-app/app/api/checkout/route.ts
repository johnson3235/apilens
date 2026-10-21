import { apiLens } from '@/lib/apilens.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UPSTREAM = process.env.DEMO_API_URL ?? 'http://localhost:4001';

async function handlePOST(request: Request) {
  try {
    const body = await request.json();
    const customer = await fetch(`${UPSTREAM}/api/customers/${encodeURIComponent(body.customerId ?? '1')}`, { cache: 'no-store' });
    if (!customer.ok) {
      return Response.json({ error: 'Customer lookup failed' }, { status: customer.status });
    }
    const payment = await fetch(`${UPSTREAM}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return Response.json(await payment.json(), { status: payment.status });
  } catch (error: unknown) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export const POST = apiLens.wrapRoute(handlePOST);
