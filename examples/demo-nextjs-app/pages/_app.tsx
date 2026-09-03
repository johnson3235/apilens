import type { AppProps } from 'next/app';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import '../styles/globals.css';
import '../styles/checkout.css';

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  return (
    <>
      <Head>
        <title>ApiLens Demo App</title>
        <meta name="description" content="Demo Application for ApiLens" />
      </Head>
      <div className="site-shell">
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="ApiLens Store home"><span className="brand-mark" aria-hidden="true">A</span><span><strong>ApiLens</strong><small>Experience Lab</small></span></Link>
          <nav aria-label="Primary navigation">
            <Link href="/" aria-current={router.pathname === '/' ? 'page' : undefined}>Products</Link>
            <Link href="/checkout" aria-current={router.pathname === '/checkout' ? 'page' : undefined}>Checkout <span className="nav-count">2</span></Link>
          </nav>
          <div className="lab-status"><span aria-hidden="true" />QA environment</div>
        </header>
        <main id="main-content" className="site-main" tabIndex={-1}>
          <Component {...pageProps} />
        </main>
        <footer><span>ApiLens Experience Lab</span><span>Safe environment for capture, tracing and failure testing</span></footer>
      </div>
    </>
  );
}
