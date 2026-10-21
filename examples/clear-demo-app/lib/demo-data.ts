/**
 * Dummy customer data served by the fake backend services.
 * Every contact id gets the same data, echoed back with its own id.
 */

export const DEFAULT_CONTACT_ID = '3055861';

export const customer = {
  firstName: 'Alex',
  lastName: 'Byrne',
  plan: 'Unlimited Max 5G',
};

/** Outstanding balance: the two unpaid bills below (2 × €40.00). */
export function balanceFor(contactId: string) {
  return {
    accountId: `ACC-${contactId}`,
    contactId,
    outstandingBalance: { value: 80.0, currency: 'EUR' },
    dueDate: '2026-10-28',
    overdue: false,
    lastPayment: { value: 39.99, currency: 'EUR', date: '2026-08-02' },
  };
}

export function nextBillFor(contactId: string) {
  return {
    accountId: `ACC-${contactId}`,
    contactId,
    billDate: '2026-11-01',
    period: { from: '2026-10-01', to: '2026-10-31' },
    total: { value: 12.99, currency: 'EUR' },
    lines: [
      { code: 'PLAN', description: 'Unlimited Max 5G (promo month)', value: 9.99 },
      { code: 'ADDON', description: 'EU roaming add-on', value: 3.0 },
    ],
  };
}

export function invoicesFor(contactId: string) {
  return {
    accountId: `ACC-${contactId}`,
    contactId,
    invoices: [
      { invoiceId: 'INV-2026-09', period: 'September 2026', issuedOn: '2026-10-01', amount: 40.0, status: 'UNPAID' },
      { invoiceId: 'INV-2026-08', period: 'August 2026', issuedOn: '2026-09-01', amount: 40.0, status: 'UNPAID' },
      { invoiceId: 'INV-2026-07', period: 'July 2026', issuedOn: '2026-08-01', amount: 39.99, status: 'PAID' },
      { invoiceId: 'INV-2026-06', period: 'June 2026', issuedOn: '2026-07-01', amount: 39.99, status: 'PAID' },
      { invoiceId: 'INV-2026-05', period: 'May 2026', issuedOn: '2026-06-01', amount: 42.1, status: 'PAID' },
      { invoiceId: 'INV-2026-04', period: 'April 2026', issuedOn: '2026-05-01', amount: 39.99, status: 'PAID' },
    ],
  };
}
