import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCapturedRequest } from '@apilens/core';
import { redactRequest } from '@apilens/security';
import { CapturedHeaders } from './CapturedHeaders';

describe('captured header inspection', () => {
  it('shows diagnostic headers without exposing redacted secrets', () => {
    const safe = redactRequest({ ...createCapturedRequest({ sessionId: 'qa', url: 'http://localhost/api/test', method: 'GET', channel: 'page-hook' }), requestHeaders: { Authorization: 'Bearer private-secret', 'x-correlation-id': 'trace-123' }, responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'private-session' } });
    const html = renderToStaticMarkup(<CapturedHeaders requestHeaders={safe.requestHeaders} responseHeaders={safe.responseHeaders} />);
    expect(html).toContain('Authorization');
    expect(html).toContain('trace-123');
    expect(html).toContain('application/json');
    expect(html).not.toContain('private-secret');
    expect(html).not.toContain('private-session');
  });
  it('explains unavailable headers without inventing values', () => {
    const html = renderToStaticMarkup(<CapturedHeaders requestHeaders={{}} responseHeaders={{}} />);
    expect(html).toContain('No headers captured for this observation.');
    expect(html).toContain('may expose only a subset');
  });
});
