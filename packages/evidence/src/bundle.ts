import type {
  AssertionReport,
  AutomationLinkage,
  CapturedRequest,
  ConsoleMessage,
  ContractSet,
  EvidenceArtifact,
  EvidenceBundle,
  EvidenceEnvironmentInfo,
  EvidenceExportOptions,
  QaSession,
  RedactionPolicy,
  ResponseAssertion,
  Rule,
  TraceSpan,
} from '@apilens/shared-types';
import { DEFAULT_EVIDENCE_EXPORT_OPTIONS } from '@apilens/shared-types';
import { isStaticAssetPath } from '@apilens/core';
import { anyUnmaskedSecrets, redactRequest } from '@apilens/security';
import { buildTraceTrees, correlate } from '@apilens/trace-engine';
import { analyseErrors, analysePerformance, computeSessionStats } from '@apilens/insights';
import { runAssertionsForSession, validateSession } from '@apilens/contract-validation';
import { harArtifact, slug } from './har';
import { markdownArtifact } from './markdown';
import { htmlArtifact } from './html';

export interface BuildEvidenceInput {
  session: QaSession;
  requests: CapturedRequest[];
  spans: TraceSpan[];
  rules: Rule[];
  environment: EvidenceEnvironmentInfo;
  consoleMessages?: ConsoleMessage[];
  automation?: AutomationLinkage | null;
  assertions?: ResponseAssertion[];
  contracts?: ContractSet[];
  redactionPolicy?: RedactionPolicy;
  options?: Partial<EvidenceExportOptions>;
}

function stripBodies(request: CapturedRequest): CapturedRequest {
  return {
    ...request,
    requestBody: request.requestBody
      ? { ...request.requestBody, content: null, encoding: 'omitted', omittedReason: 'Bodies excluded from this export.' }
      : null,
    responseBody: request.responseBody
      ? { ...request.responseBody, content: null, encoding: 'omitted', omittedReason: 'Bodies excluded from this export.' }
      : null,
  };
}

/**
 * Assembles a complete, self-consistent evidence bundle.
 *
 * Redaction is applied here — the last point before data leaves the tool —
 * unless the user explicitly disabled it, in which case the bundle is flagged
 * so every exporter can render a prominent warning.
 */
export function buildEvidenceBundle(input: BuildEvidenceInput): EvidenceBundle {
  const options: EvidenceExportOptions = { ...DEFAULT_EVIDENCE_EXPORT_OPTIONS, ...input.options };

  let requests = input.options?.includeStaticAssets
    ? input.requests
    : input.requests.filter((request) => request.type !== 'static' && !isStaticAssetPath(request.path));

  if (!options.disableRedaction && input.redactionPolicy) {
    requests = requests.map((request) => redactRequest(request, input.redactionPolicy));
  }
  if (!options.includeBodies) {
    requests = requests.map(stripBodies);
  }

  const correlation = correlate(requests, input.spans);
  const traces = buildTraceTrees(correlation.spans, { requestIdBySpanId: correlation.requestIdBySpanId });
  const stats = computeSessionStats(requests, traces, input.session.startedAt, input.session.endedAt);
  const performance = analysePerformance(requests, traces);
  const errors = analyseErrors(requests, { trees: traces });

  const assertions: AssertionReport | null =
    input.assertions && input.assertions.length > 0 ? runAssertionsForSession(input.assertions, requests) : null;

  const schemaValidations =
    input.contracts && input.contracts.length > 0 ? validateSession(requests, input.contracts) : [];

  return {
    formatVersion: 1,
    generatedAt: Date.now(),
    session: input.session,
    stats,
    environment: input.environment,
    requests,
    spans: correlation.spans,
    traces,
    appliedRules: input.rules.filter((rule) => rule.appliedCount > 0 || rule.enabled),
    insights: performance.insights,
    errors,
    performance,
    assertions,
    schemaValidations,
    consoleMessages: input.consoleMessages ?? [],
    automation: input.automation ?? null,
    containsUnmaskedSecrets: options.disableRedaction && anyUnmaskedSecrets(requests),
  };
}

export function jsonArtifact(bundle: EvidenceBundle): EvidenceArtifact {
  return {
    fileName: `${slug(bundle.session.name)}.json`,
    contentType: 'application/json',
    content: JSON.stringify(bundle, null, 2),
  };
}

/** Renders the bundle into the requested set of file artifacts. */
export function renderArtifacts(
  bundle: EvidenceBundle,
  options: Partial<EvidenceExportOptions> = {},
): EvidenceArtifact[] {
  const resolved: EvidenceExportOptions = { ...DEFAULT_EVIDENCE_EXPORT_OPTIONS, ...options };
  const artifacts: EvidenceArtifact[] = [];

  resolved.formats.forEach((format) => {
    switch (format) {
      case 'json':
        artifacts.push(jsonArtifact(bundle));
        break;
      case 'har':
        artifacts.push(harArtifact(bundle, resolved.includeStaticAssets));
        break;
      case 'markdown':
        artifacts.push(markdownArtifact(bundle));
        break;
      case 'html':
        artifacts.push(htmlArtifact(bundle));
        break;
      default:
        break;
    }
  });

  return artifacts;
}
