import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CLEAR Demo · My Account',
  description: 'Dummy My Account app with dummy data, for ApiLens QA demos.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="demo-banner">Demo app · dummy data only · built for ApiLens QA testing</div>
        <header className="topbar">
          <a href="/myaccount" className="brand">
            <span className="brand-mark">C</span>
            <span>CLEAR <em>Demo</em></span>
          </a>
          <nav className="nav">
            <a href="/myaccount">Dashboard</a>
            <a href="/myaccount/billing?contactId=3055861">Billing</a>
          </nav>
          <div className="avatar" title="Alex Byrne">AB</div>
        </header>
        <main className="page">{children}</main>
        <footer className="footer">CLEAR Demo — not a real service. All names and amounts are made up.</footer>
      </body>
    </html>
  );
}
