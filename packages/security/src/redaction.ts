import type {
  CapturedBody,
  CapturedRequest,
  RedactionOutcome,
  RedactionPolicy,
  RedactionRule,
  RedactionStrategy,
} from '@apilens/shared-types';
import { hashString, parseJsonBody, queryJsonPath, safeJsonParse } from '@apilens/core';
import { DEFAULT_REDACTION_POLICY } from './policy';

function applyStrategy(value: string, strategy: RedactionStrategy, maskToken: string): string {
  switch (strategy) {
    case 'remove':
      return '';
    case 'hash':
      return `sha:${hashString(value)}`;
    case 'preserve-shape':
      return value.replace(/[A-Za-z0-9]/g, '•');
    case 'mask':
    default:
      return maskToken;
  }
}

function activeRules(policy: RedactionPolicy): RedactionRule[] {
  return policy.rules.filter((rule) => rule.enabled);
}

export function redactHeaders(
  headers: Record<string, string>,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionOutcome<Record<string, string>> {
  if (!policy.enabled) return { value: headers, redactedFields: [] };

  const output: Record<string, string> = {};
  const redactedFields: string[] = [];

  const ruleFor = new Map<string, RedactionRule>();
  activeRules(policy).forEach((rule) => {
    rule.headers.forEach((name) => ruleFor.set(name.toLowerCase(), rule));
  });

  Object.entries(headers).forEach(([name, value]) => {
    const rule = ruleFor.get(name.toLowerCase());
    if (!rule) {
      output[name] = value;
      return;
    }
    output[name] = applyStrategy(value, rule.strategy, policy.maskToken);
    redactedFields.push(`header:${name.toLowerCase()}`);
  });

  return { value: output, redactedFields };
}

export function redactQueryParams(
  params: Record<string, string>,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionOutcome<Record<string, string>> {
  if (!policy.enabled) return { value: params, redactedFields: [] };

  const ruleFor = new Map<string, RedactionRule>();
  activeRules(policy).forEach((rule) => {
    rule.queryParams.forEach((name) => ruleFor.set(name.toLowerCase(), rule));
  });

  const output: Record<string, string> = {};
  const redactedFields: string[] = [];
  Object.entries(params).forEach(([name, value]) => {
    const rule = ruleFor.get(name.toLowerCase());
    if (!rule) {
      output[name] = value;
      return;
    }
    output[name] = applyStrategy(value, rule.strategy, policy.maskToken);
    redactedFields.push(`query:${name.toLowerCase()}`);
  });
  return { value: output, redactedFields };
}

/**
 * Redacts secrets inside a URL's query string without altering its structure,
 * so the request remains recognisable in the inspector.
 */
export function redactUrl(url: string, policy: RedactionPolicy = DEFAULT_REDACTION_POLICY): RedactionOutcome<string> {
  if (!policy.enabled) return { value: url, redactedFields: [] };

  const names = new Map<string, RedactionRule>();
  activeRules(policy).forEach((rule) => {
    rule.queryParams.forEach((name) => names.set(name.toLowerCase(), rule));
  });
  if (names.size === 0) return { value: url, redactedFields: [] };

  const questionMark = url.indexOf('?');
  if (questionMark === -1) return { value: url, redactedFields: [] };

  const base = url.slice(0, questionMark);
  const rest = url.slice(questionMark + 1);
  const [queryString, hash = ''] = rest.split('#');
  const redactedFields: string[] = [];

  const rebuilt = (queryString ?? '')
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1) return pair;
      const key = pair.slice(0, equals);
      const rule = names.get(decodeURIComponent(key).toLowerCase());
      if (!rule) return pair;
      redactedFields.push(`query:${key.toLowerCase()}`);
      return `${key}=${encodeURIComponent(applyStrategy(decodeURIComponent(pair.slice(equals + 1)), rule.strategy, policy.maskToken))}`;
    })
    .join('&');

  return { value: `${base}?${rebuilt}${hash ? `#${hash}` : ''}`, redactedFields };
}

function redactJsonValue(
  node: unknown,
  pathNames: Set<string>,
  rulesByName: Map<string, RedactionRule>,
  policy: RedactionPolicy,
  redactedFields: string[],
  prefix: string,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item, index) => redactJsonValue(item, pathNames, rulesByName, policy, redactedFields, `${prefix}[${index}]`));
  }
  if (node === null || typeof node !== 'object') return node;

  const output: Record<string, unknown> = {};
  Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (pathNames.has(key.toLowerCase())) {
      const rule = rulesByName.get(key.toLowerCase())!;
      redactedFields.push(`body:${path}`);
      output[key] = value === null ? null : applyStrategy(String(value), rule.strategy, policy.maskToken);
      return;
    }
    output[key] = redactJsonValue(value, pathNames, rulesByName, policy, redactedFields, path);
  });
  return output;
}

function applyPatternRedaction(
  text: string,
  policy: RedactionPolicy,
  redactedFields: string[],
): string {
  let output = text;
  activeRules(policy).forEach((rule) => {
    rule.bodyPatterns.forEach((pattern) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'g');
      } catch {
        return;
      }
      output = output.replace(regex, (match) => {
        redactedFields.push(`pattern:${rule.id}`);
        return applyStrategy(match, rule.strategy, policy.maskToken);
      });
    });
  });
  return output;
}

export function redactBodyText(
  text: string,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionOutcome<string> {
  if (!policy.enabled || !text) return { value: text, redactedFields: [] };

  const redactedFields: string[] = [];
  const rulesByName = new Map<string, RedactionRule>();
  activeRules(policy).forEach((rule) => {
    rule.bodyPaths.forEach((name) => rulesByName.set(name.toLowerCase(), rule));
  });

  const parsed = safeJsonParse(text);
  if (parsed.ok && parsed.value !== null && typeof parsed.value === 'object') {
    const pathNames = new Set(rulesByName.keys());
    const redacted = redactJsonValue(parsed.value, pathNames, rulesByName, policy, redactedFields, '');
    const serialized = JSON.stringify(redacted);
    const patterned = applyPatternRedaction(serialized, policy, redactedFields);
    return { value: patterned, redactedFields: [...new Set(redactedFields)] };
  }

  const patterned = applyPatternRedaction(text, policy, redactedFields);
  return { value: patterned, redactedFields: [...new Set(redactedFields)] };
}

export function redactBody(
  body: CapturedBody | null,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): RedactionOutcome<CapturedBody | null> {
  if (!body || body.content === null) return { value: body, redactedFields: [] };
  const outcome = redactBodyText(body.content, policy);
  if (outcome.redactedFields.length === 0) return { value: body, redactedFields: [] };
  return { value: { ...body, content: outcome.value }, redactedFields: outcome.redactedFields };
}

/**
 * The single entry point capture pipelines must call before a request is
 * persisted, broadcast or exported.
 */
export function redactRequest(
  request: CapturedRequest,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): CapturedRequest {
  if (!policy.enabled) return request;

  const requestHeaders = redactHeaders(request.requestHeaders, policy);
  const responseHeaders = redactHeaders(request.responseHeaders, policy);
  const queryParams = redactQueryParams(request.queryParams, policy);
  const url = redactUrl(request.url, policy);
  const requestBody = redactBody(request.requestBody, policy);
  const responseBody = redactBody(request.responseBody, policy);

  const redactedFields = [
    ...new Set([
      ...request.redactedFields,
      ...requestHeaders.redactedFields.map((field) => `request.${field}`),
      ...responseHeaders.redactedFields.map((field) => `response.${field}`),
      ...queryParams.redactedFields,
      ...url.redactedFields,
      ...requestBody.redactedFields.map((field) => `request.${field}`),
      ...responseBody.redactedFields.map((field) => `response.${field}`),
    ]),
  ];

  return {
    ...request,
    url: url.value,
    queryParams: queryParams.value,
    requestHeaders: requestHeaders.value,
    responseHeaders: responseHeaders.value,
    requestBody: requestBody.value,
    responseBody: responseBody.value,
    redactedFields,
  };
}

/**
 * Detects whether a payload still contains something that looks like a secret.
 * Used to warn before an evidence export with masking disabled.
 */
export function containsLikelySecret(request: CapturedRequest): boolean {
  const jwt = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
  const candidates = [
    ...Object.entries(request.requestHeaders).map(([key, value]) => `${key}:${value}`),
    ...Object.entries(request.responseHeaders).map(([key, value]) => `${key}:${value}`),
    request.requestBody?.content ?? '',
    request.responseBody?.content ?? '',
  ];
  return candidates.some(
    (candidate) => jwt.test(candidate) || /^(authorization|cookie|set-cookie):\s*\S+/i.test(candidate),
  );
}

/** Convenience helper used by exporters to check a whole set at once. */
export function anyUnmaskedSecrets(requests: CapturedRequest[]): boolean {
  return requests.some(containsLikelySecret);
}

export function bodyValuesAt(body: CapturedBody | null, path: string): unknown[] {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return [];
  return queryJsonPath(parsed.value, path);
}
