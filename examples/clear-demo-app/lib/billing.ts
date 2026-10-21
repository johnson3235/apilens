/**
 * Server-side loaders for billing data: each makes one call to a backend
 * service and reshapes the answer for the UI. Used by the server-rendered
 * billing page and by the BFF endpoints the dashboard calls.
 *
 *   amount due → GET {services}/api/services/balance/:contactId
 *   next bill  → GET {services}/api/services/billing/:contactId
 *   history    → GET {services}/api/services/invoices/:contactId
 */

const BACKEND_TIMEOUT_MS = 8_000;

export interface AmountDue {
  contactId: string;
  amountDue: number;
  currency: string;
  dueDate: string | null;
  overdue: boolean;
  lastPayment: { amount: number; date: string } | null;
}

export interface NextBill {
  contactId: string;
  amount: number;
  currency: string;
  billDate: string | null;
  period: { from: string; to: string } | null;
  items: { label: string; amount: number }[];
}

export interface BillHistory {
  contactId: string;
  bills: { id: string; period: string; issuedOn: string | null; amount: number; status: 'paid' | 'unpaid' }[];
}

/** What a page section receives: the data, or a message it can show. */
export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string; httpStatus: number | null };

export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isValidContactId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{1,12}$/.test(value);
}

/** Calls a backend service and returns its JSON, or throws a BackendError the page can explain. */
async function callBackend(base: string, path: string, serviceLabel: string): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/json' };
  // Lets the server reach itself on a Vercel deployment that has Deployment Protection on.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  let response: Response;
  try {
    response = await fetch(`${base}/api/services/${path}`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new BackendError(timedOut ? 504 : 502, timedOut ? `The ${serviceLabel} did not answer in time.` : `The ${serviceLabel} could not be reached.`);
  }

  const text = await response.text();
  if (!response.ok) throw new BackendError(response.status, `The ${serviceLabel} answered ${response.status}.`);
  if (!text.trim()) throw new BackendError(502, `The ${serviceLabel} sent an empty answer.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new BackendError(502, `The ${serviceLabel} sent data that could not be read.`);
  }
}

function money(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BackendError(502, 'A backend answer was missing an amount.');
  return Math.round(value * 100) / 100;
}

export async function loadAmountDue(base: string, contactId: string): Promise<AmountDue> {
  const balance = await callBackend(base, `balance/${contactId}`, 'balance service');
  return {
    contactId,
    amountDue: money(balance?.outstandingBalance?.value),
    currency: balance?.outstandingBalance?.currency ?? 'EUR',
    dueDate: balance?.dueDate ?? null,
    overdue: Boolean(balance?.overdue),
    lastPayment: balance?.lastPayment ? { amount: money(balance.lastPayment.value), date: balance.lastPayment.date } : null,
  };
}

export async function loadNextBill(base: string, contactId: string): Promise<NextBill> {
  const bill = await callBackend(base, `billing/${contactId}`, 'billing service');
  return {
    contactId,
    amount: money(bill?.total?.value),
    currency: bill?.total?.currency ?? 'EUR',
    billDate: bill?.billDate ?? null,
    period: bill?.period ?? null,
    items: Array.isArray(bill?.lines)
      ? bill.lines.map((line: any) => ({ label: String(line?.description ?? 'Charge'), amount: money(line?.value) }))
      : [],
  };
}

export async function loadBillHistory(base: string, contactId: string): Promise<BillHistory> {
  const result = await callBackend(base, `invoices/${contactId}`, 'invoices service');
  if (!Array.isArray(result?.invoices)) throw new BackendError(502, 'The invoices service sent no bill list.');
  return {
    contactId,
    bills: result.invoices.map((invoice: any) => ({
      id: String(invoice?.invoiceId ?? '—'),
      period: String(invoice?.period ?? ''),
      issuedOn: invoice?.issuedOn ?? null,
      amount: money(invoice?.amount),
      status: invoice?.status === 'PAID' ? 'paid' : 'unpaid',
    })),
  };
}

/** Runs a loader and turns any failure into a message, so one broken service never breaks the page. */
export async function settle<T>(load: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await load };
  } catch (error) {
    if (error instanceof BackendError) return { ok: false, message: error.message, httpStatus: error.status };
    return { ok: false, message: 'Something went wrong on the server.', httpStatus: 500 };
  }
}

/** The billing page's three calls, made in parallel on the server. */
export async function loadBillingPage(base: string, contactId: string) {
  const [amountDue, nextBill, history] = await Promise.all([
    settle(loadAmountDue(base, contactId)),
    settle(loadNextBill(base, contactId)),
    settle(loadBillHistory(base, contactId)),
  ]);
  return { contactId, amountDue, nextBill, history };
}
