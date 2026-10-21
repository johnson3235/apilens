import { apiLens } from '@/lib/apilens.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, DELETE, OPTIONS } = apiLens.controlRoute();
