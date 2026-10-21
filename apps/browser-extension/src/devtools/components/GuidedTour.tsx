import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Guided walkthrough of the whole workspace.
 *
 * QA engineers inherit this tool mid-project with no handover. The deck
 * explains, for every section, what it is, when to reach for it and exactly
 * which buttons to press — so the first useful test does not depend on
 * someone being available to demonstrate it.
 *
 * Fully keyboard operable with a focus trap, because it covers the viewport.
 */

export type TourTarget =
  | 'guide' | 'setup' | 'network' | 'server' | 'traces' | 'mocks' | 'evidence' | 'academy' | 'settings';

export interface TourSlide {
  id: string;
  chapter: string;
  title: string;
  lead: string;
  /** Plain-language description of the section. */
  what: string[];
  /** Concrete click-by-click instructions. */
  how: string[];
  /** The honest limitation or safety note for this capability. */
  caution?: string;
  target?: TourTarget;
  targetLabel?: string;
}

export const TOUR_SLIDES: TourSlide[] = [
  {
    id: 'welcome',
    chapter: 'Orientation',
    title: 'What ApiLens does',
    lead: 'One place to see an API call, break it on purpose, and prove what happened.',
    what: [
      'Captures every request the inspected page makes, with headers, payloads and timing.',
      'Reads server-side calls too, when the application runs the ApiLens server SDK.',
      'Replaces a real response with a controlled failure so you can test the unhappy path.',
      'Exports the evidence a defect or a sign-off needs.',
    ],
    how: [
      'Use the left sidebar to move between sections.',
      'Press “Start QA session” in the header before you reproduce anything.',
      'Reopen this tour at any time from the “How it works” button in the header.',
    ],
    caution: 'A browser extension cannot see inside remote infrastructure. Server-side visibility exists only where the SDK is installed and switched on.',
  },
  {
    id: 'map',
    chapter: 'Orientation',
    title: 'The workspace, section by section',
    lead: 'Nine sections, each answering a different question.',
    what: [
      'Start here — the guided QA workflow and this tour.',
      'Integration setup — how to connect React, Next.js or Express.',
      'Network — every call the browser made.',
      'Server API — every call the server made, with payloads.',
      'Traces — browser and server calls joined into one journey.',
      'QA Mocks — the browser-side failure rules you have created.',
      'Evidence — the exportable proof pack.',
      'Feature academy — short lessons per capability.',
      'Settings — safety, redaction and connections.',
    ],
    how: ['Click any section in the sidebar. A badge shows how many calls it currently holds.'],
    target: 'network',
    targetLabel: 'Open Network',
  },
  {
    id: 'session',
    chapter: 'Capture',
    title: 'Start a QA session first',
    lead: 'A session groups one customer journey and everything it produced.',
    what: [
      'Recording ties requests, traces, markers and active mock rules to one named session.',
      'Evidence exports and trace correlation both work from the active session.',
    ],
    how: [
      'Click “Start QA session” in the top-right of the header.',
      'Reload the inspected page so the capture hooks attach cleanly.',
      'Perform the journey you want to test, end to end.',
      'Click “Stop recording” so timings are final before exporting.',
    ],
    caution: 'Without an active session, live calls still appear but nothing is persisted for evidence.',
  },
  {
    id: 'network',
    chapter: 'Network',
    title: 'Network — what the browser sent',
    lead: 'The full list of calls, newest last, updating live.',
    what: [
      'Method, status, endpoint, host, originating page, source, response size and duration.',
      'Red rows failed. Purple rows were answered by one of your mock rules.',
      '“Source” tells you how the call was observed — page hooks see payloads, the browser network layer does not.',
    ],
    how: [
      'Click any row to open its full detail on the right.',
      'Use “Extract” to save or copy the calls you are currently looking at.',
      '“Clear” empties the list without stopping the session.',
    ],
    target: 'network',
    targetLabel: 'Open Network',
  },
  {
    id: 'filters',
    chapter: 'Network',
    title: 'Find the one call you care about',
    lead: 'Type plain words, or narrow precisely with field filters.',
    what: [
      '“Show” switches between API calls, page documents, static assets or everything.',
      '“Outcome” isolates failed, mocked, slow or still-pending calls.',
      'The search box accepts plain words and advanced terms together.',
    ],
    how: [
      'Press / anywhere to jump into the search box.',
      'Type words to match anywhere: billing account.',
      'Narrow by field: status:5xx  method:POST  host:api.vodafone  body:contactId.',
      'Exclude with a minus: -image. Combine alternatives with a comma: status:4xx,5xx.',
      'Click the ? next to the box for the full syntax list, then click an example to insert it.',
      'Each active filter becomes a chip under the box — click a chip to remove it.',
    ],
    caution: 'If the list empties, ApiLens names the filter responsible and offers a one-click undo.',
  },
  {
    id: 'pages',
    chapter: 'Network',
    title: 'Scope calls to one page',
    lead: 'Separate the billing screen’s calls from everything else in the session.',
    what: [
      'Every captured call remembers the page it came from.',
      '“All pages” shows the whole session; “This page” follows the inspected tab.',
      'The dropdown lists every page seen, with its call and failure counts.',
    ],
    how: [
      'Choose “This page” while reproducing a single screen.',
      'Switch to “All pages” to follow a journey across several screens.',
      'Pick a specific page from the dropdown to review it after the fact.',
    ],
    target: 'network',
    targetLabel: 'Open Network',
  },
  {
    id: 'detail',
    chapter: 'Network',
    title: 'Read a call in full',
    lead: 'Six tabs covering everything captured about one request.',
    what: [
      'Summary — identity, timing, sizes, environment and a failure analysis when it went wrong.',
      'Request — query parameters, headers and the payload that was sent.',
      'Response — headers and the body that came back.',
      'Trace — the correlation identity that links it to server spans.',
      'Checks — assertion and contract results for this endpoint.',
      'Code — a ready-made cURL, fetch or Playwright snippet.',
    ],
    how: [
      'Select a row, then move through the tabs.',
      'Use “Copy” in the Code tab to reproduce the call outside the browser.',
      '“Mock this” turns the selected call into a failure rule.',
    ],
    caution: 'Sensitive header and body values are redacted before storage and cannot be recovered here.',
  },
  {
    id: 'browser-mocks',
    chapter: 'Mocking',
    title: 'Break a browser call on purpose',
    lead: 'Prove the UI behaves when an API misbehaves — without touching a backend.',
    what: [
      'Rules intercept the call inside the page and return your response instead.',
      'Presets cover service failures, auth expiry, rate limits, latency, network loss and payload defects.',
      '“Apply mode” controls whether it fires every time, once, or after N calls.',
    ],
    how: [
      'Select the real call in Network, then press “Mock this”.',
      'Pick a preset — the URL pattern and method are already filled from the real request.',
      'Save the rule. It is created disabled on purpose.',
      'Enable it in QA Mocks, then repeat the journey and watch the UI.',
    ],
    caution: 'Rules start disabled and are scoped to the captured path. Widen the pattern only deliberately, and never on an environment holding real customer data.',
    target: 'mocks',
    targetLabel: 'Open QA Mocks',
  },
  {
    id: 'server',
    chapter: 'Server',
    title: 'Server API — what the server sent',
    lead: 'The calls your BFF makes after the browser request ends.',
    what: [
      'Incoming route handlers and the upstream calls they make.',
      'Request and response payloads, headers, timing and correlation identity.',
      'Works against a remote dev deployment, not just localhost.',
    ],
    how: [
      'Install the ApiLens server SDK in the application and enable its control endpoint.',
      'In Settings → Instrumented server, paste the endpoint URL and control token.',
      'Press “Test connection” before saving so a wrong value is caught immediately.',
      'Open Server API and use the application.',
    ],
    caution: 'The control token exposes captured traffic to anyone holding it. Keep it off environments with real customer data.',
    target: 'server',
    targetLabel: 'Open Server API',
  },
  {
    id: 'server-mocks',
    chapter: 'Mocking',
    title: 'Break an upstream service',
    lead: 'Fail the service the browser never talks to directly.',
    what: [
      'Server mock rules run inside the Node process, between your route and its upstream.',
      'Presets cover 503, 401, 429, latency, connection failure, timeout, truncated JSON and empty responses.',
      '“Mutate real response” calls the real upstream, then edits fields in its JSON.',
    ],
    how: [
      'In Server API, click a backend call and press “Simulate a problem”.',
      'Choose what should go wrong (for example “Service is down”), then “Save and turn on”.',
      'Enable the rule and repeat the journey.',
    ],
    caution: 'Never target an endpoint with real financial or order side effects. Rules live in process memory and disappear when the server restarts.',
    target: 'server',
    targetLabel: 'Open Server API',
  },
  {
    id: 'traces',
    chapter: 'Analysis',
    title: 'Traces — the whole journey',
    lead: 'Browser call → route handler → upstream service, in one tree.',
    what: [
      'Spans are grouped by trace id and nested by parent.',
      'Server payloads appear inline when the SDK captured them.',
      'Gaps are labelled rather than hidden, so a missing parent is obvious.',
    ],
    how: [
      'Enable trace-header injection in Settings for a controlled environment.',
      'Record a session and complete a journey.',
      'Open Traces and expand a trace to follow it across services.',
    ],
    target: 'traces',
    targetLabel: 'Open Traces',
  },
  {
    id: 'extract',
    chapter: 'Evidence',
    title: 'Extract and prove',
    lead: 'Get what you are looking at into a defect, a script or a spreadsheet.',
    what: [
      'Extract works on the filtered list — what you see is what you get.',
      'cURL and fetch reproduce a call outside the browser.',
      'HAR opens in DevTools, Charles or Fiddler. CSV and Markdown go straight into a report.',
      'Evidence packs bundle the whole session as HTML, HAR, JSON and Markdown.',
    ],
    how: [
      'Filter down to the calls that matter.',
      'Press “Extract”, then Copy or Save in the format you need.',
      'For a full session, stop recording and use Evidence → Export.',
    ],
    caution: 'Exports carry whatever was captured. Review them before attaching to a ticket.',
    target: 'evidence',
    targetLabel: 'Open Evidence',
  },
  {
    id: 'safety',
    chapter: 'Safety',
    title: 'Safety and privacy defaults',
    lead: 'The defaults assume you are working with real customer data.',
    what: [
      'Authorization, cookie and token-like headers are redacted before anything is stored.',
      'Server payloads are redacted inside the application process, before they ever leave it.',
      'Mock rules are environment-scoped and start disabled.',
      'Everything stays on this machine unless you export it.',
    ],
    how: [
      'Review the active redaction rules in Settings → Data protection.',
      'Keep “Include static assets” off for a cleaner, smaller capture.',
      'Check the environment chip in the header before enabling any mock.',
    ],
    caution: 'Redaction is a strong default, not a guarantee. Always review an export before sharing it.',
    target: 'settings',
    targetLabel: 'Open Settings',
  },
  {
    id: 'keyboard',
    chapter: 'Accessibility',
    title: 'Keyboard and accessibility',
    lead: 'Everything here is reachable without a mouse.',
    what: [
      'Tab moves through controls in reading order, with a visible focus ring.',
      'Tables expose rows to assistive technology; Enter or Space opens a row.',
      'Status changes are announced politely rather than interrupting.',
      'Dark and light themes both meet contrast requirements.',
    ],
    how: [
      '/ focuses the search box from anywhere.',
      'Escape clears the search, closes a popover, or closes this tour.',
      '← and → move through these slides; Home and End jump to the ends.',
      'Switch theme in Settings → Appearance.',
    ],
  },
  {
    id: 'ready',
    chapter: 'Ready',
    title: 'Your first test, in five steps',
    lead: 'You now know enough to find and prove a defect.',
    what: [
      '1. Start a QA session and reload the inspected page.',
      '2. Perform the journey; watch the calls arrive in Network.',
      '3. Select the call that matters and read its payload and response.',
      '4. Press “Mock this”, choose a failure, enable it and repeat the journey.',
      '5. Extract the evidence and attach it to the defect.',
    ],
    how: ['Close this tour and press “Start QA session”.'],
    target: 'network',
    targetLabel: 'Start testing',
  },
];

const SEEN_KEY = 'apilens.tour.seen.v1';

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === 'true';
  } catch {
    return true;
  }
}

export function markTourSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, 'true');
  } catch {
    // A blocked storage API must never prevent the tour from being used.
  }
}

export function GuidedTour({
  startAt = 0,
  onClose,
  onNavigate,
}: {
  startAt?: number;
  onClose: () => void;
  onNavigate: (target: TourTarget) => void;
}): JSX.Element {
  const [index, setIndex] = useState(() => Math.min(Math.max(startAt, 0), TOUR_SLIDES.length - 1));
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const slide = TOUR_SLIDES[index]!;
  const isLast = index === TOUR_SLIDES.length - 1;

  const close = useCallback(() => {
    markTourSeen();
    onClose();
  }, [onClose]);

  const go = useCallback((next: number) => {
    setIndex(Math.min(Math.max(next, 0), TOUR_SLIDES.length - 1));
  }, []);

  // Focus moves into the dialog and returns to its opener on close.
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previousFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'Escape': event.preventDefault(); close(); return;
        case 'ArrowRight': event.preventDefault(); go(index + 1); return;
        case 'ArrowLeft': event.preventDefault(); go(index - 1); return;
        case 'Home': event.preventDefault(); go(0); return;
        case 'End': event.preventDefault(); go(TOUR_SLIDES.length - 1); return;
        case 'Tab': {
          // Focus trap: the tour covers the viewport, so Tab must not escape it.
          const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (!focusable || focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
          return;
        }
        default:
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close, go, index]);

  return (
    <div className="tour-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div
        className="tour-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apilens-tour-title"
        aria-describedby="apilens-tour-lead"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="tour-head">
          <div>
            <span className="overline">{slide.chapter}</span>
            <h2 id="apilens-tour-title">{slide.title}</h2>
            <p id="apilens-tour-lead" className="tour-lead">{slide.lead}</p>
          </div>
          <button type="button" className="btn sm" onClick={close} aria-label="Close the tour">Skip tour</button>
        </header>

        <div className="tour-body">
          <section className="tour-column">
            <h3>What this is</h3>
            <ul>{slide.what.map((line) => <li key={line}>{line}</li>)}</ul>
          </section>
          <section className="tour-column">
            <h3>How to use it</h3>
            <ol>{slide.how.map((line) => <li key={line}>{line}</li>)}</ol>
            {slide.caution ? (
              <p className="tour-caution"><strong>Worth knowing:</strong> {slide.caution}</p>
            ) : null}
          </section>
        </div>

        <footer className="tour-foot">
          <div className="tour-dots" role="tablist" aria-label="Tour slides">
            {TOUR_SLIDES.map((item, position) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={position === index}
                aria-label={`${position + 1}. ${item.title}`}
                title={item.title}
                className={position === index ? 'on' : position < index ? 'done' : ''}
                onClick={() => go(position)}
              />
            ))}
          </div>

          <div className="tour-actions">
            <span className="muted">{index + 1} of {TOUR_SLIDES.length}</span>
            {slide.target ? (
              <button
                type="button"
                className="btn"
                onClick={() => { onNavigate(slide.target!); close(); }}
              >
                {slide.targetLabel ?? 'Open section'}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => go(index - 1)} disabled={index === 0}>Back</button>
            <button type="button" className="btn primary" onClick={() => (isLast ? close() : go(index + 1))}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
