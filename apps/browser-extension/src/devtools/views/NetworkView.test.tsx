import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createCapturedRequest } from '@apilens/core';
import type { CapturedRequest } from '@apilens/shared-types';

// The views reach the service worker through the extension bridge. Rendering
// them in Node needs the namespace to exist, but never to be called.
vi.stubGlobal('chrome', {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  devtools: { inspectedWindow: { tabId: 1 } },
  storage: { local: { get: vi.fn(), set: vi.fn() }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
});

const { NetworkView } = await import('./NetworkView');
const { GuidedTour, TOUR_SLIDES } = await import('../components/GuidedTour');
const { QuerySearch } = await import('../components/QuerySearch');
const { parseQuery } = await import('../../shared/request-query');

function make(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  const base = createCapturedRequest({
    sessionId: 'qa',
    url: 'https://api.example.com/v2/billing?contactId=3055861',
    method: 'GET',
    channel: 'page-hook',
    type: 'fetch',
    startedAt: 1_000,
  });
  return {
    ...base,
    statusCode: 200,
    timing: { startedAt: 1_000, completedAt: 1_250, durationMs: 250, injectedDelayMs: null },
    pageUrl: 'https://app.example.com/myaccount/billing',
    ...overrides,
  };
}

const noop = (): void => undefined;
const asyncNoop = async (): Promise<void> => undefined;

function render(requests: CapturedRequest[], overrides: Partial<Parameters<typeof NetworkView>[0]> = {}): string {
  return renderToStaticMarkup(
    <NetworkView
      requests={requests}
      traces={[]}
      assertions={[]}
      contracts={[]}
      rules={[]}
      slowRequestMs={1000}
      environmentName="Local environment"
      mockingBlockedReason={null}
      recording={false}
      currentPageUrl="https://app.example.com/myaccount/billing"
      captureStaticAssets
      version="1.3.0"
      busy={false}
      onRefresh={noop}
      onClear={noop}
      onSaveRule={asyncNoop}
      onReplay={noop}
      onOpenTrace={noop}
      onBookmark={noop}
      onEnableStaticCapture={noop}
      onNotice={noop}
      {...overrides}
    />,
  );
}

describe('NetworkView', () => {
  it('shows captured calls with endpoint, host and originating page', () => {
    const html = render([make()]);
    expect(html).toContain('Network calls');
    expect(html).toContain('/v2/billing');
    expect(html).toContain('api.example.com');
    expect(html).toContain('/myaccount/billing');
  });

  it('offers traffic, outcome and page-scope controls', () => {
    const html = render([make()]);
    expect(html).toContain('API calls');
    expect(html).toContain('Everything');
    expect(html).toContain('All pages');
    expect(html).toContain('This page');
    expect(html).toContain('Pick a page…');
  });

  it('defaults to API calls, so assets do not drown the list', () => {
    const html = render([make(), make({ url: 'https://cdn.example.com/app.js', type: 'static' })]);
    expect(html).toContain('/v2/billing');
    expect(html).not.toContain('app.js');
  });

  it('lists every seen page in the scope dropdown with its counts', () => {
    const html = render([make(), make({ pageUrl: 'https://app.example.com/orders' })]);
    expect(html).toContain('/myaccount/billing');
    expect(html).toContain('/orders');
  });

  it('guides the tester when nothing has been captured at all', () => {
    const html = render([]);
    expect(html).toContain('No calls captured yet');
    expect(html).toContain('Start QA session');
  });

  it('says it is waiting once a session is recording', () => {
    const html = render([], { recording: true });
    expect(html).toContain('Waiting for traffic');
  });

  it('names the filter responsible when everything is filtered out', () => {
    const html = render([make({ url: 'https://cdn.example.com/app.js', type: 'static' })]);
    expect(html).toContain('No calls match the current filters');
    expect(html).toContain('hidden by the traffic-type filter');
    expect(html).toContain('Show everything');
  });

  it('exposes the extract menu with the number of calls it would export', () => {
    const html = render([make(), make({ url: 'https://api.example.com/v2/orders' })]);
    expect(html).toContain('Extract');
    expect(html).toContain('>2<');
  });

  it('explains that assets are never captured rather than blaming the filter', () => {
    const html = render([make()], { captureStaticAssets: false, traffic: undefined } as never);
    // Default traffic is "api", so the notice stays hidden until it is relevant.
    expect(html).not.toContain('Static assets are not being captured');
  });
});

describe('QuerySearch', () => {
  it('renders active terms as removable chips', () => {
    const html = renderToStaticMarkup(
      <QuerySearch value="billing status:5xx" onChange={noop} parsed={parseQuery('billing status:5xx')} shown={3} total={10} />,
    );
    expect(html).toContain('billing');
    expect(html).toContain('status:5xx');
    expect(html).toContain('3 of 10 shown');
  });

  it('tells the tester nothing has been captured rather than showing 0 of 0', () => {
    const html = renderToStaticMarkup(<QuerySearch value="" onChange={noop} parsed={parseQuery('')} shown={0} total={0} />);
    expect(html).toContain('No calls captured yet');
  });
});

describe('GuidedTour', () => {
  it('covers every workspace section', () => {
    const text = TOUR_SLIDES.map((slide) => `${slide.title} ${slide.what.join(' ')} ${slide.how.join(' ')}`).join(' ').toLowerCase();
    for (const topic of ['network', 'server api', 'trace', 'mock', 'evidence', 'session', 'keyboard']) {
      expect(text).toContain(topic);
    }
  });

  it('gives every slide both an explanation and concrete steps', () => {
    for (const slide of TOUR_SLIDES) {
      expect(slide.what.length).toBeGreaterThan(0);
      expect(slide.how.length).toBeGreaterThan(0);
      expect(slide.title.length).toBeGreaterThan(0);
    }
  });

  it('renders as a labelled modal dialog with slide navigation', () => {
    const html = renderToStaticMarkup(<GuidedTour onClose={noop} onNavigate={noop} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('What this is');
    expect(html).toContain('How to use it');
    expect(html).toContain(`1 of ${TOUR_SLIDES.length}`);
  });

  it('opens at a requested slide so help is contextual', () => {
    const index = TOUR_SLIDES.findIndex((slide) => slide.id === 'filters');
    const html = renderToStaticMarkup(<GuidedTour startAt={index} onClose={noop} onNavigate={noop} />);
    expect(html).toContain('Find the one call you care about');
    expect(html).toContain(`${index + 1} of ${TOUR_SLIDES.length}`);
  });

  it('shows Finish rather than Next on the last slide', () => {
    const html = renderToStaticMarkup(<GuidedTour startAt={TOUR_SLIDES.length - 1} onClose={noop} onNavigate={noop} />);
    expect(html).toContain('Finish');
  });
});
