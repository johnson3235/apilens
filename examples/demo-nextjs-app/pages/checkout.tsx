import { useState, useEffect } from 'react';
import { GetServerSideProps } from 'next';

interface Customer {
  id: string;
  name: string;
  email: string;
}

interface Product {
  id: string;
  name: string;
  price: number;
}

interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  price: number;
}

interface Cart {
  items: CartItem[];
  total: number;
}

interface CheckoutProps {
  customer: Customer | null;
  products: Product[];
  error?: string;
}

export const getServerSideProps: GetServerSideProps<CheckoutProps> = async (context) => {
  // Wrap with SDK context manually for SSR if middleware isn't present
  const sessionId = context.req.headers['x-qa-session-id'] as string;
  const rules = context.req.headers['x-apilens-rules'] as string;
  const qaHeaders = {
    ...(sessionId ? { 'x-qa-session-id': sessionId } : {}),
    ...(rules ? { 'x-apilens-rules': rules } : {})
  };
  
  try {
    const customerRes = await fetch('http://localhost:4001/api/customers/1', {
      headers: qaHeaders
    });
    const productsRes = await fetch('http://localhost:4001/api/products', {
      headers: qaHeaders
    });
    
    const customer = customerRes.ok ? await customerRes.json() : null;
    const products = productsRes.ok ? await productsRes.json() : [];

    return { props: { customer, products } };
  } catch (error: unknown) {
    return { props: { customer: null, products: [], error: error instanceof Error ? error.message : String(error) } };
  }
};

export default function Checkout({ customer, error }: CheckoutProps) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<'idle' | 'processing' | 'success' | 'error'>('idle');
  const [paymentError, setPaymentError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/cart')
      .then(res => res.json())
      .then(setCart)
      .catch(console.error);
  }, []);

  const handlePay = async () => {
    setPaymentStatus('processing');
    setPaymentError(null);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: cart?.total, customerId: customer?.id })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.json();
      setPaymentStatus('success');
    } catch (err: unknown) {
      setPaymentStatus('error');
      setPaymentError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) return <div className="error-state" role="alert"><span>!</span><div><strong>Checkout data could not be loaded</strong><p>{error}. Confirm the demo API is running on port 4001.</p></div></div>;

  return (
    <div className="checkout-page">
      <div className="checkout-heading"><span className="eyebrow">CUSTOMER JOURNEY · STEP 2 OF 2</span><h1>Review and complete checkout</h1><p>This flow produces server-side and browser requests for tracing, mocking, and recovery testing.</p></div>
      <div className="checkout-grid"><section className="checkout-main" aria-labelledby="order-heading">
      {customer && (
        <div className="customer-card">
          <span className="avatar" aria-hidden="true">{customer.name.slice(0, 1)}</span><div><small>Ordering for</small><strong>{customer.name}</strong><span>{customer.email}</span></div><span className="verified">Verified</span>
        </div>
      )}
      
      {cart && (
        <div className="order-card">
          <div className="card-heading"><div><span className="eyebrow">YOUR ORDER</span><h2 id="order-heading">Order summary</h2></div><span>{cart.items.length} items</span></div>
          <ul className="order-list">
            {cart.items.map(item => (
              <li key={item.productId}><span className="item-icon" aria-hidden="true">{item.name.slice(0,1)}</span><div><strong>{item.name}</strong><small>Quantity {item.quantity}</small></div><strong>${(item.price * item.quantity).toFixed(2)}</strong>
              </li>
            ))}
          </ul>
          <div className="order-total">
            <span>Total</span>
            <span>${cart.total.toFixed(2)}</span>
          </div>
        </div>
      )}

      </section><aside className="payment-card"><span className="eyebrow">SECURE DEMO PAYMENT</span><h2>Complete test payment</h2><p>No real payment or customer data is transmitted in this local experience.</p>
      {paymentStatus === 'success' ? (
        <div className="success-state" role="status"><span>✓</span><strong>Payment simulation successful</strong><p>The journey is ready to review in ApiLens.</p><a className="button secondary" href="/">Return to products</a>
        </div>
      ) : (
        <button 
          className="button primary pay-button"
          onClick={handlePay} 
          disabled={paymentStatus === 'processing'}
        >
          {paymentStatus === 'processing' ? 'Processing...' : `Pay $${cart?.total.toFixed(2) || '0.00'}`}
        </button>
      )}

      {paymentStatus === 'error' && (
        <div className="payment-error" role="alert"><strong>Payment failed</strong><span>{paymentError}. Review the failed request in ApiLens, then retry.</span>
        </div>
      )}<div className="payment-meta"><span>Local only</span><span>Redaction enabled</span><span>Evidence ready</span></div></aside></div>
    </div>
  );
}
