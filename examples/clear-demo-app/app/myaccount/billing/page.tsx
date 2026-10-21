import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { apiLens } from '@/lib/apilens';
import { servicesBase } from '@/lib/bff';
import { isValidContactId, loadBillingPage, type Loaded } from '@/lib/billing';
import { DEFAULT_CONTACT_ID } from '@/lib/demo-data';
import { euro, shortDate } from '@/lib/format';

/**
 * Server-rendered billing page, like the real feature: the three backend
 * calls happen on the server while the page is built, so the browser makes
 * no API calls at all — ApiLens shows them under Server API, not Network.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function requestOrigin(incoming: Headers): string {
  const host = incoming.get('x-forwarded-host')?.split(',')[0]?.trim() || incoming.get('host') || 'localhost:3000';
  const proto = incoming.get('x-forwarded-proto')?.split(',')[0]?.trim() || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function BillingPage({ searchParams }: { searchParams: { contactId?: string | string[] } }) {
  const raw = Array.isArray(searchParams.contactId) ? searchParams.contactId[0] : searchParams.contactId;
  const contactId = isValidContactId(raw) ? raw : DEFAULT_CONTACT_ID;
  const incoming = headers() as unknown as Headers;
  const pageUrl = `/myaccount/billing?contactId=${contactId}`;

  const { amountDue, nextBill, history } = await apiLens.traceRender(
    { path: pageUrl, headers: incoming },
    () => loadBillingPage(servicesBase(requestOrigin(incoming)), contactId),
  );

  return (
    <>
      <div className="hero">
        <div>
          <p className="eyebrow"><a href="/myaccount">Dashboard</a> / Billing</p>
          <h1>Billing</h1>
          <p className="muted">Contact {contactId} · Account ACC-{contactId}</p>
          <span className="where server">Loaded on the server</span>
        </div>
        <a className="btn secondary" href={pageUrl}>Refresh</a>
      </div>

      <div className="grid two">
        <Card title="Amount due" result={amountDue} retryHref={pageUrl} testId="amount-due">
          {(data) => (
            <>
              <p className="big-number">{euro(data.amountDue, data.currency)}</p>
              <p className="muted">
                {data.amountDue === 0 ? 'Nothing to pay — you are all paid up.' : `Due by ${shortDate(data.dueDate)}`}
              </p>
              {data.lastPayment ? (
                <p className="muted small">Last payment {euro(data.lastPayment.amount, data.currency)} on {shortDate(data.lastPayment.date)}</p>
              ) : null}
              {data.amountDue > 0 ? <button className="btn" disabled title="Payments are switched off in this demo">Pay {euro(data.amountDue, data.currency)}</button> : null}
            </>
          )}
        </Card>

        <Card title="Next bill" result={nextBill} retryHref={pageUrl} testId="next-bill">
          {(data) => (
            <>
              <p className="big-number">{euro(data.amount, data.currency)}</p>
              <p className="muted">
                Issued {shortDate(data.billDate)}
                {data.period ? ` · for ${shortDate(data.period.from)} – ${shortDate(data.period.to)}` : ''}
              </p>
              {data.items.length ? (
                <ul className="lines">
                  {data.items.map((item) => (
                    <li key={item.label}>
                      <span>{item.label}</span>
                      <span>{euro(item.amount, data.currency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No charges listed yet.</p>
              )}
            </>
          )}
        </Card>
      </div>

      <Card title="Bill history" result={history} retryHref={pageUrl} testId="bill-history">
        {(data) =>
          data.bills.length === 0 ? (
            <p className="muted">You have no bills yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Bill</th><th>Period</th><th>Issued</th><th className="num">Amount</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {data.bills.map((bill) => (
                    <tr key={bill.id}>
                      <td className="mono">{bill.id}</td>
                      <td>{bill.period}</td>
                      <td>{shortDate(bill.issuedOn)}</td>
                      <td className="num">{euro(bill.amount)}</td>
                      <td><span className={`pill ${bill.status}`}>{bill.status === 'paid' ? 'Paid' : 'Unpaid'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Card>
    </>
  );
}

/** A section that shows its data, or a friendly error whose Try again reloads the page. */
function Card<T>({ title, result, retryHref, testId, children }: {
  title: string;
  result: Loaded<T>;
  retryHref: string;
  testId: string;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className="card" data-testid={testId}>
      <h2 className="card-title">{title}</h2>
      {result.ok ? children(result.data) : (
        <div className="error-box" role="alert">
          <p><strong>We couldn’t load this right now.</strong></p>
          <p className="muted">{result.message}</p>
          <div className="row">
            {/* A full page load, so retrying stays a server-side request too. */}
            <a className="btn secondary" href={retryHref}>Try again</a>
            <span className="tech">{result.httpStatus ? `HTTP ${result.httpStatus}` : 'No response'}</span>
          </div>
        </div>
      )}
    </section>
  );
}
