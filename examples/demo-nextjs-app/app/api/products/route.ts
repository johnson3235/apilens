import { apiLens } from '@/lib/apilens.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UPSTREAM = process.env.DEMO_API_URL ?? 'http://localhost:4001';

async function handleGET() {
  try {
    const upstream = await fetch(`${UPSTREAM}/api/products`, { cache: 'no-store' });
    return Response.json(await upstream.json(), { status: upstream.status });
  } catch (error: unknown) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export const GET = apiLens.wrapRoute(handleGET);
