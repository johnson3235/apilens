'use client';

import { useState } from 'react';
import { Section } from '@/components/Section';
import { euro, shortDate } from '@/lib/format';
import { isAmountDue, isNextBill, useApi, type AmountDue, type NextBill } from '@/lib/use-api';

const CONTACT_ID = '3055861';
const BILLING_URL = `/myaccount/billing?contactId=${CONTACT_ID}`;

const QUICK_ACTIONS = [
  { title: 'My plan', text: 'Unlimited Max 5G' },
  { title: 'Usage', text: '18.4 GB of unlimited' },
  { title: 'Add-ons', text: 'EU roaming active' },
  { title: 'Payment methods', text: 'Visa ending 4242' },
  { title: 'Devices', text: '1 phone, 1 SIM' },
  { title: 'Support', text: 'Chat or call us' },
];

export default function Dashboard() {
  const due = useApi<AmountDue>(`/api/billing/amount-due?contactId=${CONTACT_ID}`, isAmountDue);
  const next = useApi<NextBill>(`/api/billing/next-bill?contactId=${CONTACT_ID}`, isNextBill);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      <div className="hero">
        <div>
          <p className="eyebrow">My Account</p>
          <h1>Hi Alex</h1>
          <p className="muted">Account ACC-{CONTACT_ID} · Unlimited Max 5G</p>
          <span className="where browser">Loaded in the browser</span>
        </div>
      </div>

      <div className="grid two">
        <Section title="Amount due" state={due.state} onRetry={due.reload} testId="dashboard-amount-due">
          {(data) => (
            <>
              <p className="big-number">{euro(data.amountDue, data.currency)}</p>
              <p className="muted">Due by {shortDate(data.dueDate)}</p>
              <div className="row">
                <button className="btn" onClick={() => setNotice('Payments are switched off in this demo.')}>Pay now</button>
                <a className="btn secondary" href={BILLING_URL}>View bills</a>
              </div>
            </>
          )}
        </Section>

        <Section title="Next bill" state={next.state} onRetry={next.reload} testId="dashboard-next-bill">
          {(data) => (
            <>
              <p className="big-number">{euro(data.amount, data.currency)}</p>
              <p className="muted">On {shortDate(data.billDate)}</p>
              <div className="row">
                <a className="btn" href={BILLING_URL} data-testid="open-next-bill">View next bill</a>
              </div>
            </>
          )}
        </Section>
      </div>

      {notice ? (
        <div className="notice" role="status">
          {notice}
          <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      ) : null}

      <h2 className="section-heading">Manage your account</h2>
      <div className="grid three">
        {QUICK_ACTIONS.map((action) => (
          <button key={action.title} className="tile" onClick={() => setNotice(`“${action.title}” is not part of this demo — try Billing.`)}>
            <strong>{action.title}</strong>
            <span className="muted">{action.text}</span>
          </button>
        ))}
        <a className="tile accent" href={BILLING_URL}>
          <strong>Billing</strong>
          <span>Amount due, next bill and history</span>
        </a>
      </div>
    </>
  );
}
