import { useEffect, useState } from 'react';

interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
  inStock: boolean;
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/products')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load products');
        return res.json();
      })
      .then(data => {
        setProducts(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="loading-state" role="status"><span /><strong>Preparing the experience lab</strong><small>Loading test products…</small></div>;
  if (error) return <div className="error-state" role="alert"><span>!</span><div><strong>Products could not be loaded</strong><p>{error}. Check the API service and try again.</p></div><button className="button secondary" onClick={() => location.reload()}>Try again</button></div>;

  return (
    <div className="page-stack">
      <section className="hero"><div><span className="eyebrow">VOIS IE · QA EXPERIENCE LAB</span><h1>Explore a customer journey built for confident testing.</h1><p>Capture real API traffic, validate resilience, and create clear evidence in a safe local environment.</p><div className="hero-actions"><a className="button primary" href="#products">Browse products</a><a className="button secondary" href="/checkout">Test checkout flow</a></div></div><aside><span className="pulse" /><strong>Test environment ready</strong><p>Open DevTools → ApiLens to inspect every request.</p></aside></section>
      <section className="trust-row" aria-label="Experience features"><div><strong>Live capture</strong><span>Fetch and XHR</span></div><div><strong>Safe mocking</strong><span>Controlled failures</span></div><div><strong>Evidence ready</strong><span>Exportable sessions</span></div></section>
      <section id="products" className="catalog"><div className="section-head"><div><span className="eyebrow">DEMO CATALOG</span><h2>Featured products</h2><p>Use these interactions to generate realistic traffic in ApiLens.</p></div><span className="result-count">{products.length} products</span></div>
        <div className="product-grid">{products.map((product, index) => <article className="product-card" key={product.id}><div className={`product-visual visual-${index % 4}`} aria-hidden="true"><span>{product.name.slice(0, 1)}</span><em>{product.inStock ? 'Available' : 'Unavailable'}</em></div><div className="product-copy"><span className="product-type">QA demo item</span><h3>{product.name}</h3><p>{product.description}</p><div className="product-bottom"><strong>${product.price.toFixed(2)}</strong><button className="icon-button" disabled={!product.inStock} onClick={() => { setAdded(product.id); setTimeout(() => setAdded(null), 1800); }} aria-label={product.inStock ? `Add ${product.name} to cart` : `${product.name} is out of stock`}>{added === product.id ? 'Added ✓' : product.inStock ? 'Add to cart' : 'Out of stock'}</button></div></div></article>)}</div>
      </section>
      {added ? <div className="toast" role="status">Item added to the demo cart <a href="/checkout">Review checkout</a></div> : null}
    </div>
  );
}
