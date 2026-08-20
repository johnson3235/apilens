import { AsyncLocalStorage } from 'node:async_hooks';
import type { Rule } from '@apilens/shared-types';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface QAContext {
  sessionId: string;
  scenarioId?: string;
  rules?: Rule[];
  traceContext: TraceContext;
}

const contextStorage = new AsyncLocalStorage<QAContext>();

export function getSessionId(): string | null {
  const ctx = contextStorage.getStore();
  return ctx?.sessionId || null;
}

export function getScenarioId(): string | null {
  const ctx = contextStorage.getStore();
  return ctx?.scenarioId || null;
}

export function getTraceContext(): TraceContext | null {
  const ctx = contextStorage.getStore();
  return ctx?.traceContext || null;
}

export function getFullContext(): QAContext | undefined {
  return contextStorage.getStore();
}

export function runWithContext<T>(context: QAContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}
