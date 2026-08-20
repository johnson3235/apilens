import type { Rule } from '@apilens/shared-types';

export interface InterceptorFrameHealth {
  installed?: boolean;
  fetchPatched?: boolean;
  xhrPatched?: boolean;
  ruleCount?: number;
  rulesRevision?: string;
}

export function revisionForRules(rules: Rule[]) {
  // appliedCount is telemetry, not mock configuration. Excluding it prevents a
  // successful mock from making an otherwise synchronized page look stale.
  const serialized = JSON.stringify(rules.map(rule =>
    Object.fromEntries(Object.entries(rule).filter(([key]) => key !== 'appliedCount'))
  ));
  let hash = 1_469_598_103_934_665_603n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(serialized.charCodeAt(index))) * 1_099_511_628_211n);
  }
  return `v1-${hash.toString(16).padStart(16, '0')}`;
}

export function isTopFrameSynchronized(
  status: InterceptorFrameHealth | undefined,
  enabledRuleCount: number,
  expectedRevision: string
) {
  return Boolean(
    status?.installed &&
    status.fetchPatched &&
    status.xhrPatched &&
    Number(status.ruleCount) === enabledRuleCount &&
    status.rulesRevision === expectedRevision
  );
}
