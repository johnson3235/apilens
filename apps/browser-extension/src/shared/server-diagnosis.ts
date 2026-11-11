import type { ServerBridgeStatus } from './server-control';

/**
 * Answers "the server is connected, so why is the list empty?" in words a
 * tester can act on, from the counters the SDK reports in /health (0.5+).
 *
 * Each finding names the cause and, where there is one, the exact change to
 * hand to the developer who owns the app.
 */

export type DiagnosisState = 'ok' | 'warn' | 'fail' | 'info';

export interface DiagnosisCheck {
  id: string;
  state: DiagnosisState;
  title: string;
  detail: string;
  /** A config line or command to copy for the app's developer. */
  fix?: string;
}

export interface CaptureDiagnosis {
  /** The single most useful thing to say, as a headline. */
  headline: string;
  tone: DiagnosisState;
  checks: DiagnosisCheck[];
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function diagnoseCapture(status: ServerBridgeStatus | null, visibleCalls: number): CaptureDiagnosis | null {
  const health = status?.health;
  if (!status?.connected || !health) return null;

  const checks: DiagnosisCheck[] = [];
  const pods = status.pods?.length ?? 1;

  checks.push(health.enabled
    ? { id: 'enabled', state: 'ok', title: 'ApiLens is on in the app', detail: `${health.serviceName} · SDK ${health.sdkVersion}` }
    : { id: 'enabled', state: 'fail', title: 'ApiLens is off in the app', detail: 'The control plane answers, but capture is disabled.', fix: 'APILENS_ENABLED=true   # then restart the app' });

  // Settings the SDK switched off at boot instead of crashing (0.4+).
  for (const issue of health.configIssues ?? []) {
    if (issue.setting === 'instrumentation') continue; // explained by the capture check below
    checks.push({ id: `config:${issue.setting}`, state: 'warn', title: `${issue.setting} is switched off`, detail: issue.problem });
  }
  if (typeof health.bufferedBytes === 'number' && health.maxBufferBytes && health.bufferedBytes > health.maxBufferBytes * 0.8) {
    checks.push({
      id: 'memory',
      state: 'warn',
      title: 'Server memory for captures is nearly full',
      detail: `${Math.round(health.bufferedBytes / 1048576)} MB of ${Math.round(health.maxBufferBytes / 1048576)} MB used; the oldest calls are dropped first. Clear the list when you start a new journey.`,
    });
  }

  if (status.gap) {
    checks.push({ id: 'gap', state: 'warn', title: 'Some calls were dropped', detail: 'The server buffer filled up between polls. Raise control.bufferSize or poll more often.' });
  }

  const capture = health.capture;
  if (!capture) {
    checks.push({
      id: 'old-sdk',
      state: 'info',
      title: `SDK ${health.sdkVersion} cannot say why calls are missing`,
      detail: 'Update the app to @apilens/next-sdk 0.5.0 or later for an exact reason. Meanwhile, the usual causes: install() not called from instrumentation.ts (Next 14 needs experimental.instrumentationHook), the app address missing from allowedAppOrigins, or captureWithoutSession off.',
    });
    return summarise(checks, visibleCalls);
  }

  if (!capture.installed) {
    checks.push({
      id: 'installed',
      state: 'fail',
      title: 'Capture was never switched on',
      detail: 'apiLens.install() has not run in this server process, so no request is observed.',
      fix: "// instrumentation.ts\nexport async function register() {\n  if (process.env.NEXT_RUNTIME === 'nodejs') (await import('./lib/apilens.server')).apiLens.install();\n}\n// next.config.js (Next 14)\nexperimental: { instrumentationHook: true }",
    });
  } else if (capture.installedBy === 'first-connection') {
    checks.push({
      id: 'installed',
      state: 'warn',
      title: 'Capture started when you connected',
      detail: 'install() did not run at boot, so ApiLens switched itself on just now. Requests before that were missed, and it happens again after every restart.',
      fix: 'experimental: { instrumentationHook: true }   // next.config.js, Next 14',
    });
  } else {
    checks.push({ id: 'installed', state: 'ok', title: 'Capture is switched on', detail: 'install() ran when the server started.' });
  }

  if (capture.installed && capture.requestsSeen === 0) {
    checks.push({
      id: 'traffic',
      state: 'warn',
      title: 'No page request has reached this server yet',
      detail: pods > 1
        ? `Open or reload a page in the app. ${plural(pods, 'server pod')} answer behind a load balancer; each is polled in turn.`
        : 'Open or reload a page in the app. If you just did, the page may be served by a different server than the one you connected to.',
    });
  } else if (capture.installed) {
    checks.push({
      id: 'traffic',
      state: 'ok',
      title: `${plural(capture.requestsSeen, 'request')} reached the server`,
      detail: `${capture.requestsRecorded} recorded · ${capture.backendCalls} backend call${capture.backendCalls === 1 ? '' : 's'}${capture.cacheHits ? ` · ${capture.cacheHits} from Next’s cache` : ''}${capture.middlewareRuns ? ` · ${plural(capture.middlewareRuns, 'middleware run')}` : ''}`,
    });
  }

  const skipped = capture.skipped;
  if (skipped.originNotAllowed > 0) {
    const origin = capture.lastRejectedOrigin;
    checks.push({
      id: 'origin',
      state: capture.requestsRecorded === 0 ? 'fail' : 'warn',
      title: `${plural(skipped.originNotAllowed, 'request')} ignored: unknown app address`,
      detail: origin
        ? `They arrived as ${origin}, which is not in allowedAppOrigins. Pages at the address you connected through are accepted automatically from SDK 0.5.`
        : 'Their address is not in allowedAppOrigins.',
      fix: origin ? `allowedAppOrigins: ['${origin}'],` : undefined,
    });
  }
  if (skipped.noSession > 0) {
    checks.push({
      id: 'session',
      state: capture.requestsRecorded === 0 ? 'fail' : 'warn',
      title: `${plural(skipped.noSession, 'request')} ignored: no QA session`,
      detail: 'captureWithoutSession is off, so only requests tagged by a recording QA session are kept. Start a QA session (with “Tag my traffic” on), or turn it on for a shared dev server.',
      fix: 'captureWithoutSession: true,',
    });
  }
  if (skipped.noBackendCall > 0 && capture.backendCalls === 0 && capture.cacheHits === 0) {
    checks.push({
      id: 'backend',
      state: 'info',
      title: 'Pages loaded, but the server called no backend',
      detail: `${plural(skipped.noBackendCall, 'page load')} made no server-side call, so there was nothing to show. If the page fetches its data from the browser, those calls are under Browser calls.`,
    });
  }
  if (skipped.ignoredPath > 0) {
    checks.push({
      id: 'ignored',
      state: 'info',
      title: `${plural(skipped.ignoredPath, 'request')} skipped by autoInstrument.ignorePaths`,
      detail: 'Expected for health checks and polling endpoints.',
    });
  }
  return summarise(checks, visibleCalls);
}

function summarise(checks: DiagnosisCheck[], visibleCalls: number): CaptureDiagnosis {
  const failing = checks.find((check) => check.state === 'fail');
  const warning = checks.find((check) => check.state === 'warn');
  const lead = failing ?? warning;
  if (lead) return { headline: lead.title, tone: lead.state, checks };
  return {
    headline: visibleCalls > 0 ? 'Capture is working' : 'Capture is ready — use the app to see its server calls',
    tone: 'ok',
    checks,
  };
}
