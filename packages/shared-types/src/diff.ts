export type DiffChangeKind = 'added' | 'removed' | 'changed' | 'type-changed' | 'unchanged';

export interface JsonDiffEntry {
  /** Dotted path, e.g. `data.items[0].amountDue`. */
  path: string;
  kind: DiffChangeKind;
  left: unknown;
  right: unknown;
  leftType: string;
  rightType: string;
}

export interface JsonDiff {
  entries: JsonDiffEntry[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  typeChangedCount: number;
  identical: boolean;
  /** Set when one or both sides were not valid JSON. */
  parseError: string | null;
}

export interface HeaderDiffEntry {
  name: string;
  kind: DiffChangeKind;
  left: string | null;
  right: string | null;
}

export interface ResponseDiff {
  status: { left: number | null; right: number | null; changed: boolean };
  durationMs: { left: number | null; right: number | null; deltaMs: number | null };
  headers: HeaderDiffEntry[];
  body: JsonDiff;
  /** Raw text diff summary when bodies are not JSON. */
  textChanged: boolean;
}

export interface EndpointKey {
  method: string;
  hostname: string;
  pathTemplate: string;
}

export interface EndpointComparison {
  endpoint: EndpointKey;
  presence: 'both' | 'left-only' | 'right-only';
  leftCount: number;
  rightCount: number;
  leftAverageDurationMs: number | null;
  rightAverageDurationMs: number | null;
  durationDeltaMs: number | null;
  leftStatusCodes: number[];
  rightStatusCodes: number[];
  statusChanged: boolean;
  /** Schema-shape differences between representative responses. */
  schemaDiff: JsonDiff | null;
}

export interface SessionComparison {
  leftLabel: string;
  rightLabel: string;
  endpoints: EndpointComparison[];
  missingInRight: EndpointKey[];
  extraInRight: EndpointKey[];
  statusRegressions: EndpointComparison[];
  slowerInRight: EndpointComparison[];
  generatedAt: number;
}
