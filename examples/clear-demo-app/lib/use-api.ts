'use client';

import { useCallback, useEffect, useState } from 'react';

export type ApiState<T> =
  | { status: 'loading'; slow: boolean }
  | { status: 'ok'; data: T }
  | { status: 'error'; message: string; httpStatus: number | null };

const SLOW_AFTER_MS = 2_500;

/**
 * Loads one BFF endpoint and turns every way it can fail into a message the
 * page can show — the behaviour QA checks when ApiLens simulates a problem.
 */
export function useApi<T>(url: string, isValid: (value: any) => boolean): { state: ApiState<T>; reload: () => void } {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', slow: false });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', slow: false });
    const slowTimer = setTimeout(() => {
      if (!cancelled) setState((current) => (current.status === 'loading' ? { status: 'loading', slow: true } : current));
    }, SLOW_AFTER_MS);

    (async () => {
      try {
        const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
        const text = await response.text();
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = undefined;
        }
        if (cancelled) return;
        if (!response.ok) {
          setState({ status: 'error', message: body?.error ?? 'The service is not available right now.', httpStatus: response.status });
        } else if (body === undefined) {
          setState({ status: 'error', message: 'We received data we could not read.', httpStatus: response.status });
        } else if (!isValid(body)) {
          setState({ status: 'error', message: 'Some of this information is missing.', httpStatus: response.status });
        } else {
          setState({ status: 'ok', data: body as T });
        }
      } catch {
        if (!cancelled) setState({ status: 'error', message: 'We could not connect. Check your connection and try again.', httpStatus: null });
      } finally {
        clearTimeout(slowTimer);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, [url, attempt, isValid]);

  return { state, reload };
}

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

export const isAmountDue = (value: any) => typeof value?.amountDue === 'number';
export const isNextBill = (value: any) => typeof value?.amount === 'number' && Array.isArray(value?.items);
export const isBillHistory = (value: any) => Array.isArray(value?.bills);
