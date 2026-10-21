export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { apiLens } = await import('./lib/apilens.server');
    apiLens.installFetch();
  }
}
