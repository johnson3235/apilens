import type { EvidenceArtifact, EvidenceBundle, TraceNode, TraceTree } from '@apilens/shared-types';
import { formatBytes, formatDuration, requestLabel } from '@apilens/core';
import { slug } from './har';

function statusCell(status: number | null, error: string | null): string {
  if (error) return `ERR (${error})`;
  return status === null ? '—' : String(status);
}

function renderTraceTree(tree: TraceTree): string[] {
  const lines: string[] = [];
  const walk = (node: TraceNode): void => {
    const indent = '  '.repeat(node.depth);
    const marks = [
      node.span.mockedBy ? `mocked:${node.span.mockedBy}` : null,
      node.orphaned ? 'orphaned-parent' : null,
    ].filter(Boolean);
    lines.push(
      `${indent}${node.depth > 0 ? '└── ' : ''}${node.span.serviceName} · ${node.span.operationName} · ${statusCell(node.span.statusCode, node.span.error)} · ${formatDuration(node.span.durationMs)}${marks.length ? ` · ${marks.join(', ')}` : ''}`,
    );
    node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return lines;
}

/** Markdown evidence — the format most defect trackers accept verbatim. */
export function toMarkdown(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  const { session, stats, environment } = bundle;

  lines.push(`# ${session.name}`, '');

  if (bundle.containsUnmaskedSecrets) {
    lines.push('> **WARNING** Redaction was disabled for this export. This document may contain live credentials.', '');
  }

  lines.push('## Test context', '');
  lines.push('| Field | Value |', '| --- | --- |');
  lines.push(`| Environment | ${environment.environmentName ?? environment.environmentId ?? 'Unclassified'} |`);
  lines.push(`| Start URL | ${session.startUrl ?? '—'} |`);
  lines.push(`| Started | ${new Date(session.startedAt).toISOString()} |`);
  lines.push(`| Duration | ${formatDuration(stats.durationMs)} |`);
  lines.push(`| Browser | ${environment.browser ?? '—'} |`);
  lines.push(`| Platform | ${environment.platform ?? '—'} |`);
  lines.push(`| Extension | ${environment.extensionVersion} |`);
  lines.push(`| QA agent | ${environment.agentVersion ?? 'not connected'} |`);
  if (bundle.automation) {
    lines.push(`| Automation | ${bundle.automation.framework} · ${bundle.automation.testName ?? '—'} · ${bundle.automation.status} |`);
  }
  lines.push('');

  lines.push('## Session summary', '');
  lines.push('| Metric | Value |', '| --- | --- |');
  lines.push(`| Requests | ${stats.requestCount} |`);
  lines.push(`| Failed | ${stats.failedCount} |`);
  lines.push(`| Mocked | ${stats.mockedCount} |`);
  lines.push(`| Replayed | ${stats.replayedCount} |`);
  lines.push(`| Server-side calls | ${stats.serverSideCount} |`);
  lines.push(`| Traces | ${stats.traceCount} |`);
  lines.push(`| Average duration | ${formatDuration(stats.averageDurationMs)} |`);
  lines.push(`| p95 duration | ${formatDuration(stats.p95DurationMs)} |`);
  lines.push(`| Scenarios | ${(session.scenarios ?? []).length} |`);
  lines.push(`| Screenshots | ${session.markers.filter((marker) => marker.kind === 'screenshot').length} |`);
  if (stats.slowest) lines.push(`| Slowest | ${stats.slowest.label} (${formatDuration(stats.slowest.durationMs)}) |`);
  lines.push('');

  if ((session.scenarios ?? []).length > 0) {
    lines.push('## Scenario evidence', '');
    (session.scenarios ?? []).forEach((scenario, index) => {
      const screenshots = session.markers.filter((marker) => marker.kind === 'screenshot' && marker.scenarioId === scenario.id);
      lines.push(`### ${index + 1}. ${scenario.title}`, '');
      lines.push(`- **Status:** ${scenario.status}`);
      lines.push(`- **Expected result:** ${scenario.expectedResult || 'Not provided'}`);
      lines.push(`- **Actual result:** ${scenario.actualResult || 'Not provided'}`);
      lines.push(`- **Screenshots:** ${screenshots.length}`);
      if (scenario.startedAt) lines.push(`- **Recorded at:** ${new Date(scenario.startedAt).toISOString()}`);
      if (scenario.notes) lines.push(`- **Notes:** ${scenario.notes}`);
      if (screenshots.length > 0) {
        lines.push('', 'Visual evidence:');
        screenshots.forEach((marker) => lines.push(`- ${marker.label} - ${new Date(marker.timestamp).toISOString()}${marker.detail ? ` - ${marker.detail}` : ''}`));
        lines.push('', '> Screenshot pixels are embedded in the HTML report and must be reviewed for sensitive information before sharing.');
      }
      lines.push('');
    });
  }

  if (bundle.automation && bundle.automation.steps.length > 0) {
    lines.push('## Test steps', '');
    lines.push('| # | Step | Result | Duration |', '| --- | --- | --- | --- |');
    bundle.automation.steps.forEach((step, index) => {
      lines.push(`| ${index + 1} | ${step.title} | ${step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '–'} | ${formatDuration(step.durationMs)} |`);
    });
    const failed = bundle.automation.steps.find((step) => step.status === 'failed');
    if (failed?.error) lines.push('', `**Failure:** ${failed.error}`);
    lines.push('');
  }

  if (bundle.appliedRules.length > 0) {
    lines.push('## Mock configuration', '');
    lines.push('| Rule | Failure | Applied | Scope |', '| --- | --- | --- | --- |');
    bundle.appliedRules.forEach((rule) => {
      const scope = rule.conditions.map((condition) => `${condition.field} ${condition.operator} ${condition.value}`).join(' AND ') || 'all requests';
      lines.push(`| ${rule.name} | ${rule.action.type}${rule.action.statusCode ? ` (${rule.action.statusCode})` : ''} | ${rule.appliedCount} | ${scope} |`);
    });
    lines.push('');
  }

  const failures = bundle.requests.filter((request) => request.error !== null || (request.statusCode ?? 0) >= 400);
  if (failures.length > 0) {
    lines.push('## Failed APIs', '');
    lines.push('| Method | Endpoint | Status | Duration | Channel | Mocked |', '| --- | --- | --- | --- | --- | --- |');
    failures.forEach((request) => {
      lines.push(
        `| ${request.method} | \`${request.path}\` | ${statusCell(request.statusCode, request.error)} | ${formatDuration(request.timing.durationMs)} | ${request.channel} | ${request.mock?.ruleName ?? '—'} |`,
      );
    });
    lines.push('');

    const sample = failures[0]!;
    lines.push('### First failure detail', '');
    lines.push(`**${requestLabel(sample)}** → ${statusCell(sample.statusCode, sample.error)}`, '');
    if (sample.requestBody?.content) {
      lines.push('Request body:', '', '```json', sample.requestBody.content, '```', '');
    }
    if (sample.responseBody?.content) {
      lines.push('Response body:', '', '```json', sample.responseBody.content, '```', '');
    }
  }

  if (bundle.errors.groups.length > 0) {
    lines.push('## Error analysis', '');
    lines.push('| Category | Endpoint group | Count | Likely source |', '| --- | --- | --- | --- |');
    bundle.errors.groups.forEach((group) => {
      lines.push(
        `| ${group.category} | ${group.label} | ${group.count} | ${group.likelyFailureSource ? `${group.likelyFailureSource.service} (observed)` : 'no server telemetry'} |`,
      );
    });
    lines.push('');
  }

  if (bundle.traces.length > 0) {
    lines.push('## API traces', '');
    bundle.traces.slice(0, 10).forEach((tree) => {
      lines.push(`### Trace \`${tree.traceId.slice(0, 12)}\` · ${formatDuration(tree.durationMs)} · ${tree.spanCount} spans`, '');
      lines.push('```text', ...renderTraceTree(tree), '```', '');
      if (tree.hasGaps) {
        lines.push('> Some spans referenced a parent that was never received; the trace is incomplete.', '');
      }
    });
  }

  if (bundle.insights.length > 0) {
    lines.push('## QA insights', '');
    bundle.insights.forEach((insight) => {
      lines.push(`### ${insight.severity.toUpperCase()} · ${insight.title}`, '');
      lines.push(`**Observed:** ${insight.observed}`, '');
      if (insight.possibleCause) lines.push(`**Possible cause:** ${insight.possibleCause}`, '');
      if (insight.recommendation) lines.push(`**Recommendation:** ${insight.recommendation}`, '');
    });
  }

  if (bundle.assertions && bundle.assertions.results.length > 0) {
    lines.push('## Assertions', '');
    lines.push(`${bundle.assertions.passedCount} passed, ${bundle.assertions.failedCount} failed.`, '');
    lines.push('| Assertion | Result | Expected | Actual |', '| --- | --- | --- | --- |');
    bundle.assertions.results.forEach((result) => {
      lines.push(`| ${result.assertionName} | ${result.passed ? '✓' : '✗'} | ${result.expected} | ${result.actual} |`);
    });
    lines.push('');
  }

  const schemaFailures = bundle.schemaValidations.filter((entry) => !entry.result.valid);
  if (schemaFailures.length > 0) {
    lines.push('## Contract violations', '');
    lines.push('| Request | Violation | Path | Expected | Actual |', '| --- | --- | --- | --- | --- |');
    schemaFailures.forEach((entry) => {
      entry.result.violations.forEach((violation) => {
        lines.push(`| ${entry.requestId.slice(0, 8)} | ${violation.kind} | \`${violation.path}\` | ${violation.expected} | ${violation.actual} |`);
      });
    });
    lines.push('');
  }

  if (bundle.consoleMessages.length > 0) {
    lines.push('## Console errors', '');
    bundle.consoleMessages.slice(0, 50).forEach((message) => {
      lines.push(`- \`${message.level}\` ${message.text}`);
    });
    lines.push('');
  }

  lines.push('## Full request log', '');
  lines.push('| # | Method | Endpoint | Status | Duration | Size | Channel |', '| --- | --- | --- | --- | --- | --- | --- |');
  bundle.requests.forEach((request, index) => {
    lines.push(
      `| ${index + 1} | ${request.method} | \`${request.hostname}${request.path}\` | ${statusCell(request.statusCode, request.error)} | ${formatDuration(request.timing.durationMs)} | ${formatBytes(request.responseBody?.byteLength ?? 0)} | ${request.channel} |`,
    );
  });
  lines.push('');
  lines.push('---', '', `Generated by ApiLens at ${new Date(bundle.generatedAt).toISOString()}.`);

  return lines.join('\n');
}

export function markdownArtifact(bundle: EvidenceBundle): EvidenceArtifact {
  return {
    fileName: `${slug(bundle.session.name)}.md`,
    contentType: 'text/markdown',
    content: toMarkdown(bundle),
  };
}
