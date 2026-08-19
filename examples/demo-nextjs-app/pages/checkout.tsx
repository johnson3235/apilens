import { useState, useEffect } from 'react';
import { GetServerSideProps } from 'next';
import sdk from '../apilens.config';

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
  
  try {
    const customerRes = await fetch('http://localhost:4001/api/customers/1', {
      headers: sessionId ? { 'x-qa-session-id': sessionId } : {}
    });
    const productsRes = await fetch('http://localhost:4001/api/products', {
      headers: sessionId ? { 'x-qa-session-id': sessionId } : {}
    });
    
    const customer = customerRes.ok ? await customerRes.json() : null;
    const products = productsRes.ok ? await productsRes.json() : [];

    return { props: { customer, products } };
  } catch (error: any) {
    return { props: { customer: null, products: [], error: error.message } };
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
    } catch (err: any) {
      setPaymentStatus('error');
      setPaymentError(err.message);
    }
  };

  if (error) return <div>Error loading checkout data: {error}</div>;

  return (
    <div>
      <h2>Checkout</h2>
      {customer && (
        <div style={{ marginBottom: '1rem', padding: '1rem', backgroundColor: '#f3f4f6', borderRadius: '4px' }}>
          <h3>Customer Details</h3>
          <p>{customer.name} ({customer.email})</p>
        </div>
      )}
      
      {cart && (
        <div style={{ marginBottom: '1rem', padding: '1rem', border: '1px solid #e5e7eb', borderRadius: '4px' }}>
          <h3>Order Summary</h3>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {cart.items.map(item => (
              <li key={item.productId} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0' }}>
                <span>{item.name} x {item.quantity}</span>
                <span>${(item.price * item.quantity).toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <hr />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
            <span>Total</span>
            <span>${cart.total.toFixed(2)}</span>
          </div>
        </div>
      )}

      {paymentStatus === 'success' ? (
        <div style={{ color: 'green', padding: '1rem', backgroundColor: '#dcfce7', borderRadius: '4px' }}>
          Payment successful! Thank you for your order.
        </div>
      ) : (
        <button 
          onClick={handlePay} 
          disabled={paymentStatus === 'processing'}
          style={{
            backgroundColor: '#2563eb',
            color: 'white',
            padding: '1rem 2rem',
            border: 'none',
            borderRadius: '4px',
            fontSize: '1.1rem',
            cursor: paymentStatus === 'processing' ? 'wait' : 'pointer',
            width: '100%'
          }}
        >
          {paymentStatus === 'processing' ? 'Processing...' : `Pay $${cart?.total.toFixed(2) || '0.00'}`}
        </button>
      )}

      {paymentStatus === 'error' && (
        <div style={{ color: 'red', marginTop: '1rem', padding: '1rem', backgroundColor: '#fee2e2', borderRadius: '4px' }}>
          Payment failed: {paymentError}
        </div>
      )}
    </div>
  );
}
