import { apiLens } from '@/lib/apilens.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGET() {
  return Response.json({
    items: [{ productId: '1', name: 'Widget Pro', quantity: 2, price: 29.99 }],
    total: 59.98,
  });
}

export const GET = apiLens.wrapRoute(handleGET);
