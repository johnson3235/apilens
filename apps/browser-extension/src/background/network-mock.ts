import type { CapturedRequest, EnvironmentPolicy, RequestMethod, Rule } from '@apilens/shared-types';
import {
  captureBody,
  completeRequest,
  contentTypeOf,
  createCapturedRequest,
  normalizeHeaders,
  parseUrl,
} from '@apilens/core';
import { decideMock, executeAction, mockMarkerHeaders } from '@apilens/mock-engine';

interface PausedRequest {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  frameId?: string;
}

export interface NetworkMockEvents {
  onMockedRequest(tabId: number, request: CapturedRequest, networkRequestId: string): void;
  log(message: string): void;
}

/**
 * Chromium network-level mock engine.
 *
 * Some pages are hardened against MAIN-world patching (strict CSP, frozen
 * intrinsics, Trusted Types). When the page hooks cannot install, the
 * DevTools `Fetch` domain can still fulfil or fail a request before it leaves
 * the browser. It is a fallback, not the default, because attaching the
 * debugger shows a visible banner and is Chromium-only.
 */
export class ChromiumNetworkMock {
  private readonly attached = new Set<number>();
  private readonly errors = new Map<number, string>();
  private listening = false;

  constructor(
    private readonly getRules: () => Rule[],
    private readonly getPolicy: () => EnvironmentPolicy,
    private readonly events: NetworkMockEvents,
  ) {}

  isActive(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  error(tabId: number): string | null {
    return this.errors.get(tabId) ?? null;
  }

  available(): boolean {
    return typeof chrome !== 'undefined' && typeof chrome.debugger?.attach === 'function';
  }

  async enable(tabId: number): Promise<{ active: boolean; error: string | null }> {
    if (!this.available()) {
      const error = 'Network-level mocking requires the Chromium debugger API, which this browser does not expose.';
      this.errors.set(tabId, error);
      return { active: false, error };
    }
    if (this.attached.has(tabId)) return { active: true, error: null };

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.ensureListener();
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
      this.attached.add(tabId);
      this.errors.delete(tabId);
      return { active: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.set(tabId, message);
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Nothing attached.
      }
      return { active: false, error: message };
    }
  }

  async disable(tabId: number): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
      await chrome.debugger.detach({ tabId });
    } catch {
      // The tab may already be gone.
    }
  }

  async disableAll(): Promise<void> {
    await Promise.all([...this.attached].map((tabId) => this.disable(tabId)));
  }

  private ensureListener(): void {
    if (this.listening || !this.available()) return;
    this.listening = true;

    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method !== 'Fetch.requestPaused' || source.tabId === undefined) return;
      void this.handlePaused(source.tabId, params as unknown as PausedRequest);
    });

    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.attached.delete(source.tabId);
    });
  }

  private async handlePaused(tabId: number, paused: PausedRequest): Promise<void> {
    const decision = this.decide(tabId, paused);

    if (!decision) {
      await this.continueRequest(tabId, paused.requestId);
      return;
    }

    const { rule, outcome, record } = decision;

    if (outcome.requiresOriginalResponse) {
      // These rules need the genuine payload, which this stage does not have.
      await this.continueRequest(tabId, paused.requestId);
      return;
    }

    if (outcome.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));

    try {
      if (outcome.abort) {
        await chrome.debugger.sendCommand({ tabId }, 'Fetch.failRequest', {
          requestId: paused.requestId,
          errorReason: normaliseErrorReason(outcome.errorReason),
        });
        this.events.onMockedRequest(
          tabId,
          completeRequest({ ...record, error: `Aborted by ApiLens rule "${rule.name}".` }, { statusCode: null }),
          paused.requestId,
        );
        return;
      }

      const headers = { ...outcome.headers, ...mockMarkerHeaders(rule.name, 'chromium-network', rule.action.type) };
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
        requestId: paused.requestId,
        responseCode: outcome.statusCode,
        responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
        body: base64Encode(outcome.body),
      });

      this.events.onMockedRequest(
        tabId,
        completeRequest(
          {
            ...record,
            responseHeaders: headers,
            responseBody: captureBody(outcome.body, { maxBytes: 256 * 1024, mimeType: contentTypeOf(headers) }),
            timing: { ...record.timing, injectedDelayMs: outcome.delayMs || null },
          },
          { statusCode: outcome.statusCode, statusText: outcome.statusText },
        ),
        paused.requestId,
      );
    } catch (error) {
      this.events.log(`Network mock failed for ${paused.request.url}: ${error instanceof Error ? error.message : String(error)}`);
      await this.continueRequest(tabId, paused.requestId);
    }
  }

  private decide(tabId: number, paused: PausedRequest) {
    const headers = normalizeHeaders(paused.request.headers);
    const parsed = parseUrl(paused.request.url);

    const record: CapturedRequest = {
      ...createCapturedRequest({
        sessionId: '',
        url: paused.request.url,
        method: (paused.request.method || 'GET').toUpperCase() as RequestMethod,
        channel: 'browser-mock',
        source: 'browser',
        originId: String(tabId),
      }),
      requestHeaders: headers,
      requestBody: paused.request.postData
        ? captureBody(paused.request.postData, { maxBytes: 256 * 1024, mimeType: contentTypeOf(headers) })
        : null,
      hostname: parsed.hostname,
    };

    const gate = decideMock(this.getRules(), record, this.getPolicy());
    if (gate.kind !== 'apply') return null;

    const outcome = executeAction(gate.rule.action, { ruleName: gate.rule.name });
    return {
      rule: gate.rule,
      outcome,
      record: {
        ...record,
        environmentId: gate.environmentId,
        mock: {
          ruleId: gate.rule.id,
          ruleName: gate.rule.name,
          scenarioId: gate.rule.scenarioId,
          transport: 'chromium-network' as const,
          failureType: gate.rule.action.type,
          appliedAt: Date.now(),
        },
      },
    };
  }

  private async continueRequest(tabId: number, requestId: string): Promise<void> {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
    } catch {
      // The request may already have been resolved or the tab closed.
    }
  }
}

const CDP_ERROR_REASONS = new Set([
  'Failed',
  'Aborted',
  'TimedOut',
  'AccessDenied',
  'ConnectionClosed',
  'ConnectionReset',
  'ConnectionRefused',
  'ConnectionAborted',
  'ConnectionFailed',
  'NameNotResolved',
  'InternetDisconnected',
  'AddressUnreachable',
  'BlockedByClient',
  'BlockedByResponse',
]);

export function normaliseErrorReason(reason: string | null): string {
  return reason && CDP_ERROR_REASONS.has(reason) ? reason : 'Failed';
}

export function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
