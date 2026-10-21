import { useMemo, useState } from 'react';
import type { CapturedRequest, PresetInput, Rule, RuleAction } from '@apilens/shared-types';
import { RULE_PRESETS, instantiatePreset } from '@apilens/mock-engine';

/**
 * Creates a browser mock rule from a call the tester just captured.
 *
 * Starting from a real request is the whole point: the URL pattern is exact,
 * the method is known, and the rule cannot accidentally match half the
 * application. Broad patterns are possible but must be typed deliberately.
 */

const CATEGORY_LABELS: Record<string, string> = {
  failure: 'Service failures',
  auth: 'Authentication',
  network: 'Network conditions',
  latency: 'Latency',
  payload: 'Payload defects',
};

const ACTION_NEEDS_BODY = new Set(['status-code', 'custom-body']);

function patternFor(request: CapturedRequest): string {
  // Exact path, wildcard origin and query: survives an environment switch
  // without widening to every endpoint on the host.
  return `*${request.path}*`;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
      {children}
    </label>
  );
}

export function BrowserMockEditor({
  request,
  existing,
  environmentName,
  blockedReason,
  saving,
  onSave,
  onCancel,
  onDelete,
}: {
  /** The captured call this rule was started from, when there is one. */
  request: CapturedRequest | null;
  existing: Rule | null;
  environmentName: string | null;
  blockedReason: string | null;
  saving: boolean;
  onSave: (rule: Rule) => void;
  onCancel: () => void;
  onDelete?: (rule: Rule) => void;
}): JSX.Element {
  const initial = useMemo<Rule>(() => {
    if (existing) return existing;
    const seed = instantiatePreset('server-error-500', {
      urlPattern: request ? patternFor(request) : '*/api/*',
      method: request?.method ?? 'ANY',
    });
    const now = Date.now();
    return {
      ...(seed ?? {
        id: `rule-${now}`,
        scenarioId: null,
        name: 'New mock rule',
        description: '',
        priority: 10,
        conditions: [],
        conditionLogic: 'and' as const,
        action: { type: 'status-code', statusCode: 500 } as RuleAction,
        applyMode: 'always' as const,
        environments: [],
        appliedCount: 0,
        createdAt: now,
        updatedAt: now,
      }),
      // Never enabled on creation: the tester decides when traffic changes.
      enabled: false,
      name: request ? `${request.method} ${request.path} → 500` : 'New mock rule',
      description: request ? `Created from a captured ${request.type} call on ${request.hostname}.` : '',
    };
  }, [existing, request]);

  const [rule, setRule] = useState<Rule>(initial);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const patch = (changes: Partial<Rule>): void => setRule((current) => ({ ...current, ...changes, updatedAt: Date.now() }));
  const patchAction = (changes: Partial<RuleAction>): void => patch({ action: { ...rule.action, ...changes } });

  const urlCondition = rule.conditions.find((condition) => condition.field === 'url');
  const methodCondition = rule.conditions.find((condition) => condition.field === 'method');

  function setPattern(value: string): void {
    const others = rule.conditions.filter((condition) => condition.field !== 'url');
    patch({ conditions: [{ field: 'url', operator: 'glob', value }, ...others] });
  }

  function setMethod(value: string): void {
    const others = rule.conditions.filter((condition) => condition.field !== 'method');
    patch({ conditions: value === 'ANY' ? others : [...others, { field: 'method', operator: 'equals', value }] });
  }

  function applyPreset(presetId: string): void {
    const built = instantiatePreset(presetId, {
      urlPattern: urlCondition?.value ?? (request ? patternFor(request) : '*/api/*'),
      method: (methodCondition?.value as PresetInput['method']) ?? 'ANY',
    });
    if (!built) return;
    setRule((current) => ({
      ...built,
      id: current.id,
      enabled: current.enabled,
      priority: current.priority,
      applyMode: current.applyMode,
      applyLimit: current.applyLimit,
      appliedCount: current.appliedCount,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      description: current.description,
      name: `${methodCondition?.value ?? 'ANY'} ${request?.path ?? urlCondition?.value ?? ''} → ${built.name}`.trim(),
    }));
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof RULE_PRESETS>();
    for (const preset of RULE_PRESETS) {
      groups.set(preset.category, [...(groups.get(preset.category) ?? []), preset]);
    }
    return [...groups.entries()];
  }, []);

  return (
    <form
      className="mock-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(rule);
      }}
    >
      <header>
        <div>
          <span className="overline">BROWSER MOCK</span>
          <h3>{rule.name || 'New mock rule'}</h3>
          {request ? <p className="muted">Intercepts this call inside the page, before it reaches the network.</p> : null}
        </div>
        <label className="setting-toggle compact">
          <span><strong>Enabled</strong></span>
          <input type="checkbox" checked={rule.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
          <i aria-hidden="true" />
        </label>
      </header>

      {blockedReason ? (
        <div className="banner blocked" role="alert">Mocking is blocked here: {blockedReason}</div>
      ) : (
        <div className="banner info">
          <div>
            <strong>Scope check.</strong>
            <span> This rule will run on <b>{environmentName ?? 'the current environment'}</b> and only for URLs matching the pattern below.</span>
          </div>
        </div>
      )}

      <div className="preset-groups">
        {grouped.map(([category, presets]) => (
          <div key={category}>
            <h4>{CATEGORY_LABELS[category] ?? category}</h4>
            <div className="preset-row">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`chip ${rule.action.type === preset.build({ urlPattern: '' }).action.type ? 'on' : ''}`}
                  title={preset.description}
                  onClick={() => applyPreset(preset.id)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="field-grid">
        <Field label="Rule name">
          <input className="input" value={rule.name} onChange={(event) => patch({ name: event.target.value })} required maxLength={200} />
        </Field>

        <Field label="Method">
          <select className="input" value={methodCondition?.value ?? 'ANY'} onChange={(event) => setMethod(event.target.value)}>
            {['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
              <option key={method} value={method}>{method}</option>
            ))}
          </select>
        </Field>

        <Field label="URL pattern" hint="Glob — * matches anything. Keep it narrow.">
          <input className="input mono" value={urlCondition?.value ?? ''} onChange={(event) => setPattern(event.target.value)} required placeholder="*/api/billing*" />
        </Field>

        <Field label="Apply mode" hint="Use “once” to prove a retry recovers">
          <select className="input" value={rule.applyMode} onChange={(event) => patch({ applyMode: event.target.value as Rule['applyMode'] })}>
            <option value="always">Every matching call</option>
            <option value="once">Once, then stop</option>
            <option value="n-times">First N calls</option>
            <option value="after-n">Only after N calls</option>
            <option value="probability">A percentage of calls</option>
          </select>
        </Field>

        {rule.applyMode === 'n-times' || rule.applyMode === 'after-n' ? (
          <Field label="N">
            <input className="input" type="number" min={0} value={rule.applyLimit ?? 1} onChange={(event) => patch({ applyLimit: Number(event.target.value) })} />
          </Field>
        ) : null}

        {rule.applyMode === 'probability' ? (
          <Field label="Probability (%)">
            <input className="input" type="number" min={1} max={100} value={rule.applyProbability ?? 50} onChange={(event) => patch({ applyProbability: Number(event.target.value) })} />
          </Field>
        ) : null}

        {ACTION_NEEDS_BODY.has(rule.action.type) ? (
          <Field label="Status code">
            <input className="input" type="number" min={100} max={599} value={rule.action.statusCode ?? 500} onChange={(event) => patchAction({ statusCode: Number(event.target.value) })} />
          </Field>
        ) : null}

        <Field label="Added delay (ms)">
          <input className="input" type="number" min={0} step={100} value={rule.action.delayMs ?? 0} onChange={(event) => patchAction({ delayMs: Number(event.target.value) })} />
        </Field>
      </div>

      {ACTION_NEEDS_BODY.has(rule.action.type) ? (
        <Field label="Response body" hint="Leave blank for a generated error payload">
          <textarea className="input code" rows={5} value={rule.action.responseBody ?? ''} onChange={(event) => patchAction({ responseBody: event.target.value })} placeholder='{"error":"Simulated failure"}' />
        </Field>
      ) : null}

      <button type="button" className="btn sm link" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
        {showAdvanced ? 'Hide' : 'Show'} advanced options
      </button>

      {showAdvanced ? (
        <div className="field-grid">
          <Field label="Priority" hint="Lower number wins when several rules match">
            <input className="input" type="number" value={rule.priority} onChange={(event) => patch({ priority: Number(event.target.value) })} />
          </Field>
          <Field label="Description">
            <input className="input" value={rule.description} onChange={(event) => patch({ description: event.target.value })} />
          </Field>
          <Field label="Restrict to environments" hint="Comma separated; blank inherits the safety policy">
            <input className="input" value={rule.environments.join(', ')} onChange={(event) => patch({ environments: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
          </Field>
        </div>
      ) : null}

      <footer className="editor-actions">
        <button type="submit" className="btn primary" disabled={saving || !urlCondition?.value}>{saving ? 'Saving…' : existing ? 'Save changes' : 'Create rule'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {existing && onDelete ? <button type="button" className="btn danger" onClick={() => onDelete(existing)}>Delete</button> : null}
        <span className="muted">New rules start disabled. Enable one only when you are ready for traffic to change.</span>
      </footer>
    </form>
  );
}
