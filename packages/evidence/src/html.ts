import type { EvidenceArtifact, EvidenceBundle } from '@apilens/shared-types';
import { formatBytes, formatDuration } from '@apilens/core';
import { slug } from './har';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusClass(status: number | null, error: string | null): string {
  if (error) return 'err';
  if (status === null) return 'muted';
  if (status >= 500) return 'err';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'info';
  return 'ok';
}

function safeScreenshotSource(resourceRef: string | null): string | null {
  return resourceRef && /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=]+$/i.test(resourceRef) ? resourceRef : null;
}

function scenarioStatusClass(status: string): string {
  if (status === 'passed') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'blocked') return 'warn';
  return 'info';
}

const STYLES = `
:root{--bg:#f4f7fa;--panel:#fff;--border:#d9e1e8;--text:#132033;--muted:#607083;--ok:#15803d;--warn:#b45309;--err:#c81e1e;--info:#175cd3;--accent:#224aff;--navy:#073b5c;--black:#08090a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px 64px}
.report-head{margin:0 -28px 28px;padding:26px 28px 24px;border-top:8px solid var(--accent);background:linear-gradient(120deg,var(--black),#142233);color:#fff}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:3px;background:#fff;color:#000;font-size:18px;letter-spacing:-.08em}.brand em{color:#75a7ff;font-style:normal}
h1{font-size:29px;line-height:1.2;margin:0 0 7px;letter-spacing:-.025em}.report-head .sub{color:#c7d3df;margin:0}.report-id{margin-top:16px;color:#8fa6ba;font:10px ui-monospace,SFMono-Regular,Menlo,monospace}
h2{font-size:17px;color:var(--navy);margin:32px 0 12px;padding-bottom:8px;border-bottom:2px solid #dce6ee}
h3{font-size:14px;margin:20px 0 8px;color:var(--navy);font-weight:700}
.sub{color:var(--muted);margin:0 0 24px}
.banner{background:#fff4f4;border:1px solid #f4b4b4;color:var(--err);padding:12px 16px;border-radius:8px;margin-bottom:16px;font-weight:600}.banner.pixel{background:#fff8e8;border-color:#f2d38e;color:#7a4b00}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.card{background:var(--panel);border:1px solid var(--border);border-top:3px solid var(--accent);border-radius:8px;padding:14px 16px;box-shadow:0 2px 8px rgba(7,59,92,.04)}
.card .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.card .value{font-size:22px;font-weight:700;margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden;font-size:12px}
th{background:#eef4f8;text-align:left;padding:8px 10px;font-weight:700;color:var(--navy);text-transform:uppercase;font-size:10px;letter-spacing:.05em}
td{padding:7px 10px;border-top:1px solid var(--border);vertical-align:top}
td.mono,th.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}.info{color:var(--info)}.muted{color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;border:1px solid var(--border);color:var(--muted);background:#fff}
.badge.mock{border-color:var(--accent);color:var(--accent)}
pre{background:#101820;color:#e8f0f5;border:1px solid #243848;border-radius:8px;padding:12px;overflow:auto;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-height:420px}
.insight{background:var(--panel);border:1px solid var(--border);border-left-width:3px;border-radius:6px;padding:12px 14px;margin-bottom:10px}
.insight.critical{border-left-color:var(--err)}.insight.warning{border-left-color:var(--warn)}.insight.info{border-left-color:var(--info)}
.insight .t{font-weight:700;margin-bottom:6px}
.insight .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-right:6px}
.scenario{margin:0 0 22px;padding:18px;border:1px solid var(--border);border-radius:10px;background:#fff;box-shadow:0 3px 12px rgba(7,59,92,.05);break-inside:avoid-page}.scenario-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px}.scenario-head h3{margin:0;font-size:17px}.scenario-index{color:var(--accent);font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace}.scenario-status{text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:800}.scenario-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}.scenario-meta div{padding:8px 10px;border-radius:7px;background:#f5f8fb}.scenario-meta b,.scenario-meta span{display:block}.scenario-meta b{color:var(--muted);font-size:9px;text-transform:uppercase}.scenario-meta span{margin-top:2px;font-weight:700}.results{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.result{padding:11px;border:1px solid var(--border);border-radius:8px}.result b{display:block;margin-bottom:4px;color:var(--navy);font-size:10px;text-transform:uppercase}.result p{margin:0;color:var(--text)}
.screenshots{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:12px}.screenshots figure{margin:0;padding:8px;border:1px solid var(--border);border-radius:8px;background:#f7f9fb;break-inside:avoid}.screenshots img{display:block;width:100%;max-height:520px;object-fit:contain;background:#e8edf1;border-radius:4px}.screenshots figcaption{padding:7px 2px 1px;color:var(--navy);font-size:11px;font-weight:700}.screenshots figcaption small{display:block;color:var(--muted);font-weight:400}
footer{margin-top:40px;color:var(--muted);font-size:11px;border-top:1px solid var(--border);padding-top:16px}
@media print{body{background:#fff}.wrap{max-width:none;padding:0 10mm 12mm}.report-head{margin:0 -10mm 8mm;padding:10mm}.card,.scenario{box-shadow:none}h2{break-after:avoid}.scenario{break-before:page}.scenario:first-of-type{break-before:auto}table,figure{break-inside:avoid}.screenshots img{max-height:175mm}}
`;

function card(label: string, value: string | number): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div></div>`;
}

/** Self-contained HTML report — no external assets, safe to attach to a ticket. */
export function toHtml(bundle: EvidenceBundle): string {
  const { session, stats, environment } = bundle;
  const failures = bundle.requests.filter((request) => request.error !== null || (request.statusCode ?? 0) >= 400);
  const scenarios = session.scenarios ?? [];
  const screenshots = session.markers.filter((marker) => marker.kind === 'screenshot' && safeScreenshotSource(marker.resourceRef));

  const scenarioBlocks = scenarios.map((scenario, index) => {
    const nextStartedAt = scenarios[index + 1]?.startedAt ?? null;
    const end = scenario.endedAt ?? nextStartedAt ?? session.endedAt ?? bundle.generatedAt;
    const scenarioRequests = scenario.startedAt === null ? [] : bundle.requests.filter((request) => request.timing.startedAt >= scenario.startedAt! && request.timing.startedAt <= end);
    const scenarioFailures = scenarioRequests.filter((request) => request.error !== null || (request.statusCode ?? 0) >= 400).length;
    const scenarioScreenshots = screenshots.filter((marker) => marker.scenarioId === scenario.id);
    const screenshotHtml = scenarioScreenshots.map((marker) => `<figure><img src="${escapeHtml(safeScreenshotSource(marker.resourceRef)!)}" alt="${escapeHtml(marker.label)}"><figcaption>${escapeHtml(marker.label)}<small>${escapeHtml(new Date(marker.timestamp).toISOString())}${marker.detail ? ` · ${escapeHtml(marker.detail)}` : ''}</small></figcaption></figure>`).join('');
    return `<section class="scenario"><div class="scenario-head"><div><span class="scenario-index">SCENARIO ${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(scenario.title)}</h3></div><span class="scenario-status ${scenarioStatusClass(scenario.status)}">${escapeHtml(scenario.status)}</span></div><div class="scenario-meta"><div><b>Started</b><span>${scenario.startedAt ? escapeHtml(new Date(scenario.startedAt).toISOString()) : 'Not recorded'}</span></div><div><b>Requests</b><span>${scenarioRequests.length}</span></div><div><b>Failures</b><span class="${scenarioFailures ? 'err' : 'ok'}">${scenarioFailures}</span></div><div><b>Screenshots</b><span>${scenarioScreenshots.length}</span></div></div><div class="results"><div class="result"><b>Expected result</b><p>${escapeHtml(scenario.expectedResult || 'Not provided')}</p></div><div class="result"><b>Actual result</b><p>${escapeHtml(scenario.actualResult || 'Not provided')}</p></div></div>${scenario.notes ? `<div class="result"><b>Tester notes</b><p>${escapeHtml(scenario.notes)}</p></div>` : ''}${screenshotHtml ? `<h3>Visual evidence (${scenarioScreenshots.length})</h3><div class="screenshots">${screenshotHtml}</div>` : '<p class="muted">No screenshots were captured for this scenario.</p>'}</section>`;
  }).join('');

  const traceBlocks = bundle.traces
    .slice(0, 10)
    .map((tree) => {
      const rows: string[] = [];
      const walk = (node: (typeof tree.roots)[number]): void => {
        rows.push(
          `${'    '.repeat(node.depth)}${node.depth > 0 ? '└── ' : ''}${node.span.serviceName} · ${node.span.operationName} · ${node.span.statusCode ?? node.span.error ?? '—'} · ${formatDuration(node.span.durationMs)}${node.span.mockedBy ? ` · mocked:${node.span.mockedBy}` : ''}`,
        );
        node.children.forEach(walk);
      };
      tree.roots.forEach(walk);
      return `<h3>Trace ${escapeHtml(tree.traceId.slice(0, 12))} · ${formatDuration(tree.durationMs)} · ${tree.spanCount} spans${tree.hasGaps ? ' · <span class="warn">incomplete</span>' : ''}</h3><pre>${escapeHtml(rows.join('\n'))}</pre>`;
    })
    .join('');

  const insightBlocks = bundle.insights
    .map(
      (insight) => `<div class="insight ${insight.severity}">
      <div class="t"><span class="k">${escapeHtml(insight.severity)}</span>${escapeHtml(insight.title)}</div>
      <div><strong>Observed:</strong> ${escapeHtml(insight.observed)}</div>
      ${insight.possibleCause ? `<div class="muted"><strong>Possible cause:</strong> ${escapeHtml(insight.possibleCause)}</div>` : ''}
      ${insight.recommendation ? `<div class="muted"><strong>Recommendation:</strong> ${escapeHtml(insight.recommendation)}</div>` : ''}
    </div>`,
    )
    .join('');

  const requestRows = bundle.requests
    .map(
      (request, index) => `<tr>
      <td class="muted">${index + 1}</td>
      <td class="mono">${escapeHtml(request.method)}</td>
      <td class="mono">${escapeHtml(request.hostname)}${escapeHtml(request.path)}</td>
      <td class="mono ${statusClass(request.statusCode, request.error)}">${escapeHtml(request.error ? 'ERR' : String(request.statusCode ?? '—'))}</td>
      <td class="mono">${formatDuration(request.timing.durationMs)}</td>
      <td class="mono muted">${formatBytes(request.responseBody?.byteLength ?? 0)}</td>
      <td><span class="badge">${escapeHtml(request.channel)}</span>${request.mock ? ` <span class="badge mock">${escapeHtml(request.mock.ruleName)}</span>` : ''}</td>
    </tr>`,
    )
    .join('');

  const stepRows = (bundle.automation?.steps ?? [])
    .map(
      (step, index) => `<tr>
      <td class="muted">${index + 1}</td>
      <td>${escapeHtml(step.title)}</td>
      <td class="${step.status === 'passed' ? 'ok' : step.status === 'failed' ? 'err' : 'muted'}">${step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–'} ${escapeHtml(step.status)}</td>
      <td class="mono">${formatDuration(step.durationMs)}</td>
      <td class="err">${escapeHtml(step.error ?? '')}</td>
    </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(session.name)} · ApiLens evidence</title><style>${STYLES}</style></head>
<body><div class="wrap">
<header class="report-head"><div class="brand"><span class="brand-mark">C</span><span>Clear Mobile <em>Test Evidence</em></span></div><h1>${escapeHtml(session.name)}</h1><p class="sub">${escapeHtml(environment.environmentName ?? 'Unclassified environment')} · ${escapeHtml(session.startUrl ?? '')} · ${escapeHtml(new Date(session.startedAt).toISOString())}</p><div class="report-id">Evidence ID ${escapeHtml(session.id)}</div></header>
${bundle.containsUnmaskedSecrets ? '<div class="banner">Redaction was disabled for this export. This file may contain live credentials — handle it as a secret.</div>' : ''}
${screenshots.length ? '<div class="banner pixel">Screenshot pixels are visual evidence and were not automatically redacted. The tester must review them before sharing.</div>' : ''}

<h2>Session summary</h2>
<div class="cards">
  ${card('Requests', stats.requestCount)}
  ${card('Scenarios', scenarios.length)}
  ${card('Screenshots', screenshots.length)}
  ${card('Failed', stats.failedCount)}
  ${card('Mocked', stats.mockedCount)}
  ${card('Server-side', stats.serverSideCount)}
  ${card('Traces', stats.traceCount)}
  ${card('Average', formatDuration(stats.averageDurationMs))}
  ${card('p95', formatDuration(stats.p95DurationMs))}
  ${card('Duration', formatDuration(stats.durationMs))}
</div>

<h2>Test context</h2>
<table><tbody>
<tr><th>Environment</th><td>${escapeHtml(environment.environmentName ?? environment.environmentId ?? 'Unclassified')}</td></tr>
<tr><th>Browser</th><td>${escapeHtml(environment.browser ?? '—')}</td></tr>
<tr><th>Platform</th><td>${escapeHtml(environment.platform ?? '—')}</td></tr>
<tr><th>Extension</th><td>${escapeHtml(environment.extensionVersion)}</td></tr>
<tr><th>QA agent</th><td>${escapeHtml(environment.agentVersion ?? 'not connected')}</td></tr>
${bundle.automation ? `<tr><th>Automation</th><td>${escapeHtml(bundle.automation.framework)} · ${escapeHtml(bundle.automation.testName ?? '—')} · <span class="${bundle.automation.status === 'passed' ? 'ok' : 'err'}">${escapeHtml(bundle.automation.status)}</span></td></tr>` : ''}
</tbody></table>

${scenarioBlocks ? `<h2>Scenario evidence (${scenarios.length})</h2>${scenarioBlocks}` : ''}

${stepRows ? `<h2>Test steps</h2><table><thead><tr><th>#</th><th>Step</th><th>Result</th><th>Duration</th><th>Error</th></tr></thead><tbody>${stepRows}</tbody></table>` : ''}

${
  bundle.appliedRules.length > 0
    ? `<h2>Mock configuration</h2><table><thead><tr><th>Rule</th><th>Failure</th><th>Applied</th><th>Scope</th></tr></thead><tbody>${bundle.appliedRules
        .map(
          (rule) => `<tr><td>${escapeHtml(rule.name)}</td><td class="mono">${escapeHtml(rule.action.type)}${rule.action.statusCode ? ` (${rule.action.statusCode})` : ''}</td><td class="mono">${rule.appliedCount}</td><td class="mono muted">${escapeHtml(rule.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`).join(' AND ') || 'all requests')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

${
  failures.length > 0
    ? `<h2>Failed APIs (${failures.length})</h2><table><thead><tr><th>Method</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>Channel</th></tr></thead><tbody>${failures
        .map(
          (request) => `<tr><td class="mono">${escapeHtml(request.method)}</td><td class="mono">${escapeHtml(request.hostname)}${escapeHtml(request.path)}</td><td class="mono ${statusClass(request.statusCode, request.error)}">${escapeHtml(request.error ?? String(request.statusCode))}</td><td class="mono">${formatDuration(request.timing.durationMs)}</td><td><span class="badge">${escapeHtml(request.channel)}</span></td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

${
  bundle.errors.groups.length > 0
    ? `<h2>Error analysis</h2><table><thead><tr><th>Category</th><th>Group</th><th>Count</th><th>Likely source</th></tr></thead><tbody>${bundle.errors.groups
        .map(
          (group) => `<tr><td class="mono">${escapeHtml(group.category)}</td><td>${escapeHtml(group.label)}</td><td class="mono">${group.count}</td><td>${group.likelyFailureSource ? `${escapeHtml(group.likelyFailureSource.service)} <span class="badge">observed</span>` : '<span class="muted">no server telemetry</span>'}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

${traceBlocks ? `<h2>API traces</h2>${traceBlocks}` : ''}
${insightBlocks ? `<h2>QA insights</h2>${insightBlocks}` : ''}

${
  bundle.assertions && bundle.assertions.results.length > 0
    ? `<h2>Assertions (${bundle.assertions.passedCount} passed / ${bundle.assertions.failedCount} failed)</h2><table><thead><tr><th>Assertion</th><th>Result</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${bundle.assertions.results
        .map(
          (result) => `<tr><td>${escapeHtml(result.assertionName)}</td><td class="${result.passed ? 'ok' : 'err'}">${result.passed ? '✓' : '✗'}</td><td class="mono">${escapeHtml(result.expected)}</td><td class="mono">${escapeHtml(result.actual)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}

${
  bundle.consoleMessages.length > 0
    ? `<h2>Console messages</h2><pre>${escapeHtml(bundle.consoleMessages.map((message) => `[${message.level}] ${message.text}`).join('\n'))}</pre>`
    : ''
}

<h2>Full request log</h2>
<table><thead><tr><th>#</th><th>Method</th><th>Endpoint</th><th>Status</th><th>Duration</th><th>Size</th><th>Origin</th></tr></thead><tbody>${requestRows}</tbody></table>

<footer>Generated by ApiLens ${escapeHtml(environment.extensionVersion)} at ${escapeHtml(new Date(bundle.generatedAt).toISOString())}. ${bundle.containsUnmaskedSecrets ? 'Redaction disabled.' : 'Sensitive values were masked before export.'}</footer>
</div></body></html>`;
}

export function htmlArtifact(bundle: EvidenceBundle): EvidenceArtifact {
  return {
    fileName: `${slug(bundle.session.name)}.html`,
    contentType: 'text/html',
    content: toHtml(bundle),
  };
}
