import type { AppProps } from 'next/app';
import Head from 'next/head';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>ApiLens Demo App</title>
        <meta name="description" content="Demo Application for ApiLens" />
      </Head>
      <div style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 0 }}>
        <header style={{ backgroundColor: '#2563eb', color: 'white', padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>ApiLens Store</h1>
          <nav>
            <a href="/" style={{ color: 'white', marginRight: '1rem', textDecoration: 'none' }}>Home</a>
            <a href="/checkout" style={{ color: 'white', textDecoration: 'none' }}>Checkout</a>
          </nav>
        </header>
        <main style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
          <Component {...pageProps} />
        </main>
      </div>
    </>
  );
}
