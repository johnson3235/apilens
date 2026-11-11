import { NextResponse, type NextRequest } from 'next/server';
import { withApiLens } from '@apilens/next-sdk/edge';

/**
 * A CLEAR-style session check. Next 14 runs middleware in the Edge sandbox,
 * where the Node SDK cannot see its calls; `withApiLens` records them and
 * hands them to the app's control endpoint, so the session lookup shows up in
 * the Server API view like any other backend call.
 */
async function sessionMiddleware(request: NextRequest) {
  const contactId = request.nextUrl.searchParams.get('contactId') ?? '3055861';
  const base = process.env.SERVICES_BASE_URL ?? request.nextUrl.origin;
  const session = await fetch(`${base}/api/services/session/${encodeURIComponent(contactId)}`, { cache: 'no-store' });
  if (!session.ok) return NextResponse.redirect(new URL('/?error=session', request.url));
  return NextResponse.next();
}

export const middleware = withApiLens(sessionMiddleware, {
  enabled: process.env.APILENS_ENABLED === 'true',
  controlToken: process.env.APILENS_CONTROL_TOKEN,
  serviceName: 'clear-demo-middleware',
  captureWithoutSession: true,
});

export const config = { matcher: ['/myaccount/:path*'] };
