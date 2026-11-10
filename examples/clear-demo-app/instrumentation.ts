// The only ApiLens wiring the app needs: every page, route and server action
// is captured from here, with no changes to page or route files.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { apiLens } = await import('./lib/apilens');
    apiLens.install();
  }
}
