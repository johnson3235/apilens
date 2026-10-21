import { apiLens } from '@/lib/apilens';
import { bff } from '@/lib/bff';
import { services } from '@/lib/services';

/**
 * Every API path lives in this one route on purpose.
 *
 * The SDK keeps captured calls and mock rules in memory. On Vercel each route
 * file becomes its own function, so the control endpoint, the BFF and the fake
 * services must share one route to share that memory:
 *
 *   /api/__apilens/*   ApiLens control endpoint (token protected)
 *   /api/billing/*     BFF the pages call
 *   /api/services/*    fake backend services the BFF calls
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const control = apiLens.controlRoute();

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS';
type Context = { params: { path?: string[] } };

async function route(method: Method, request: Request, { params }: Context): Promise<Response> {
  const [head, ...rest] = params.path ?? [];
  if (head === '__apilens') return control[method](request);
  if (head === 'billing') return bff(method, rest, request);
  if (head === 'services') return services(method, rest);
  return Response.json({ error: 'Not found' }, { status: 404 });
}

export const GET = (request: Request, context: Context) => route('GET', request, context);
export const POST = (request: Request, context: Context) => route('POST', request, context);
export const PUT = (request: Request, context: Context) => route('PUT', request, context);
export const DELETE = (request: Request, context: Context) => route('DELETE', request, context);
export const OPTIONS = (request: Request, context: Context) => route('OPTIONS', request, context);
