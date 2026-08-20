import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Rule } from '@apilens/shared-types';

const rule: Rule = {
  id: 'force-503', scenarioId: 'test', name: 'Force checkout 503', description: '', enabled: true,
  priority: 1, conditions: [{ field: 'path', operator: 'equals', value: '/api/checkout' }],
  conditionLogic: 'and', action: { type: 'status-code', statusCode: 503, responseBody: '{"forced":true}' },
  applyMode: 'always', appliedCount: 0, createdAt: 0, updatedAt: 0
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('ChromiumNetworkMock', () => {
  it('fulfills a matching paused fetch with the configured 503 without continuing it to the server', async () => {
    let eventListener: ((source: any, method: string, params: any) => void) | undefined;
    const attach = vi.fn(async () => undefined);
    const sendCommand = vi.fn(async () => []);
    const recorded = vi.fn();
    vi.stubGlobal('chrome', {
      debugger: {
        attach,
        detach: vi.fn(async () => undefined),
        sendCommand,
        onEvent: { addListener: (listener: typeof eventListener) => { eventListener = listener; } },
        onDetach: { addListener: vi.fn() }
      },
      scripting: { executeScript: vi.fn() }
    });

    const { ChromiumNetworkMock } = await import('../chromium-network-mock');
    const engine = new ChromiumNetworkMock(() => [rule], recorded);
    await expect(engine.enable(41)).resolves.toEqual({ active: true, error: null });

    eventListener?.({ tabId: 41 }, 'Fetch.requestPaused', {
      requestId: 'fetch-id', networkId: 'network-id', request: {
        url: 'https://shop.example.test/api/checkout', method: 'GET', headers: {}
      }
    });

    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 41 },
      'Fetch.fulfillRequest',
      expect.objectContaining({ requestId: 'fetch-id', responseCode: 503 })
    ));
    expect(sendCommand).not.toHaveBeenCalledWith({ tabId: 41 }, 'Fetch.continueRequest', { requestId: 'fetch-id' });
    await vi.waitFor(() => expect(recorded).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ statusCode: 503, scenarioApplied: 'Force checkout 503' }),
      rule,
      'network-id'
    ));
  });
});
