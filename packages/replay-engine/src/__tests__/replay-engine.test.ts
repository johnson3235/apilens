import { describe, expect, it, vi } from 'vitest';
import { createCapturedRequest, makeBody } from '@apilens/core';
import type { CapturedRequest, ReplayRequest } from '@apilens/shared-types';
import { DEFAULT_REDACTION_POLICY } from '@apilens/security';
import { buildReplayRequest, retargetReplay, withHeader, withoutHeader, withQueryParam } from '../builder';
import { CODE_TARGETS, generateCode } from '../codegen';
import { executeReplay } from '../executor';

function req(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    ...createCapturedRequest({
      sessionId: 's1',
      url: 'https://api.qa.example.com/orders?page=1',
      method: 'POST',
      channel: 'page-hook',
    }),
    requestHeaders: {
      'content-type': 'application/json',
      host: 'api.qa.example.com',
      'content-length': '17',
      accept: 'application/json',
    },
    requestBody: makeBody('{"sku":"ABC-123"}', 'application/json'),
    ...overrides,
  };
}

describe('replay building', () => {
  it('drops transport headers that must be recalculated', () => {
    const { request } = buildReplayRequest(req());
    expect(request.headers.host).toBeUndefined();
    expect(request.headers['content-length']).toBeUndefined();
    expect(request.headers['content-type']).toBe('application/json');
  });

  it('drops masked headers and reports them', () => {
    const { request, droppedHeaders } = buildReplayRequest(
      req({
        requestHeaders: { authorization: DEFAULT_REDACTION_POLICY.maskToken },
        redactedFields: ['request.header:authorization'],
      }),
      { redactionPolicy: DEFAULT_REDACTION_POLICY },
    );
    expect(request.headers.authorization).toBeUndefined();
    expect(droppedHeaders).toContain('authorization');
  });

  it('defaults to omitting credentials', () => {
    expect(buildReplayRequest(req()).request.includeCredentials).toBe(false);
  });

  it('retargets to another environment base URL', () => {
    const { request } = buildReplayRequest(req());
    expect(retargetReplay(request, 'https://api.dev.example.com').url).toBe('https://api.dev.example.com/orders?page=1');
  });

  it('prefixes a base path when retargeting', () => {
    const { request } = buildReplayRequest(req());
    expect(retargetReplay(request, 'https://gw.example.com/v2').url).toContain('/v2/orders');
  });

  it('edits headers and query parameters immutably', () => {
    const { request } = buildReplayRequest(req());
    expect(withHeader(request, 'X-Test', '1').headers['x-test']).toBe('1');
    expect(withoutHeader(withHeader(request, 'X-Test', '1'), 'x-test').headers['x-test']).toBeUndefined();
    expect(withQueryParam(request, 'page', '2').url).toContain('page=2');
    expect(withQueryParam(request, 'page', null).url).not.toContain('page=');
    expect(request.headers['x-test']).toBeUndefined();
  });
});

describe('code generation', () => {
  const replay: ReplayRequest = buildReplayRequest(req()).request;

  it('generates valid cURL for bash and PowerShell', () => {
    const bash = generateCode(replay, { target: 'curl', shell: 'bash' });
    expect(bash).toContain("curl -X POST 'https://api.qa.example.com/orders?page=1'");
    expect(bash).toContain("-H 'content-type: application/json'");

    const powershell = generateCode(replay, { target: 'curl', shell: 'powershell' });
    expect(powershell).toContain(' `\n');
  });

  it('escapes single quotes safely', () => {
    const withQuote = { ...replay, body: `{"note":"it's fine"}` };
    expect(generateCode(withQuote, { target: 'curl', shell: 'bash' })).toContain(`it'\\''s`);
    expect(generateCode(withQuote, { target: 'curl', shell: 'powershell' })).toContain("it''s");
  });

  it('generates fetch, axios, Playwright, python and REST Assured', () => {
    expect(generateCode(replay, { target: 'fetch' })).toContain('await fetch(');
    expect(generateCode(replay, { target: 'axios' })).toContain('import axios');
    expect(generateCode(replay, { target: 'playwright' })).toContain('@playwright/test');
    expect(generateCode(replay, { target: 'python-requests' })).toContain('import requests');
    expect(generateCode(replay, { target: 'rest-assured' })).toContain('.when()');
  });

  it('produces syntactically valid JSON in fetch output', () => {
    const code = generateCode(replay, { target: 'fetch' });
    const match = /body: (".*")/.exec(code);
    expect(match).not.toBeNull();
    expect(() => JSON.parse(JSON.parse(match![1]!) as string)).not.toThrow();
  });

  it('exposes the supported target list', () => {
    expect(CODE_TARGETS.map((target) => target.id)).toContain('curl');
  });
});

describe('replay execution', () => {
  const replay: ReplayRequest = { ...buildReplayRequest(req()).request, timeoutMs: 50 };

  it('captures status, headers and body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"ok":true}', { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' } }),
    );
    const response = await executeReplay(replay, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.body?.content).toBe('{"ok":true}');
    expect(response.error).toBeNull();
  });

  it('reports network failures instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const response = await executeReplay(replay, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(response.statusCode).toBeNull();
    expect(response.error).toContain('ECONNREFUSED');
  });

  it('reports a timeout when the request is aborted', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    const response = await executeReplay(replay, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(response.error).toContain('timed out');
  });

  it('reports a missing fetch implementation clearly', async () => {
    const response = await executeReplay(replay, { fetchImpl: 'not-a-function' as unknown as typeof fetch });
    expect(response.error).toContain('No fetch implementation');
  });

  it('does not send a body for GET requests', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 204 }));
    await executeReplay({ ...replay, method: 'GET' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });
});
