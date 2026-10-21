import { useState } from 'react';
import { SERVER_MOCK_PRESETS, type ServerMockRule } from '../../shared/server-control';

const ACTION_LABELS: Array<{ id: ServerMockRule['action']['type']; label: string; hint: string }> = [
  { id: 'status-code', label: 'Error status', hint: 'Return a failure status instead of calling upstream' },
  { id: 'custom-body', label: 'Custom payload', hint: 'Return a body you control' },
  { id: 'passthrough-mutate', label: 'Mutate real response', hint: 'Call upstream, then change fields or add latency' },
  { id: 'empty-response', label: 'Empty response', hint: 'Success status with no payload' },
  { id: 'invalid-json', label: 'Malformed JSON', hint: 'Truncated payload that fails to parse' },
  { id: 'network-error', label: 'Connection failure', hint: 'Upstream refuses the connection' },
  { id: 'timeout', label: 'Timeout', hint: 'Hang, then fail the call' },
];

const REPEAT_OPTIONS: Array<{ id: ServerMockRule['applyMode']; title: string; hint: string }> = [
  { id: 'once', title: 'Only the next call', hint: 'Safest on a shared server — it stops by itself after one use.' },
  { id: 'always', title: 'Every call, until I turn it off', hint: 'Other testers on this server see it too. Remember to turn it off.' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span>{label}{hint ? <small>{hint}</small> : null}</span>
      {children}
    </label>
  );
}

/** The scenario card the rule currently matches, if any. */
export function activeScenario(rule: ServerMockRule): string | null {
  for (const preset of SERVER_MOCK_PRESETS) {
    if (JSON.stringify(preset.apply(rule).action) === JSON.stringify(rule.action)) return preset.id;
  }
  return rule.action.type === 'custom-body' ? 'custom' : null;
}

/** "the backend call POST /api/payments": what this rule intercepts, in words. */
export function describeRuleTarget(rule: ServerMockRule): string {
  const where = rule.match.kind === 'server' ? 'the page’s call to this server' : rule.match.kind === 'any' ? 'any call' : 'the backend call';
  const method = rule.match.method === 'ANY' ? '' : `${rule.match.method} `;
  return `${where} ${method}${rule.match.urlPattern.replace(/^\*/, '') || '(no address yet)'}`;
}

/**
 * Editor for a single server-side mock rule.
 *
 * The main form is three plain questions so a tester needs no HTTP knowledge:
 * which call, what goes wrong, how often. Every technical field stays under
 * Developer options. Rules default to one use and are scoped to the captured
 * path, because the most damaging mistake in this tool is a broad rule that
 * quietly breaks a shared dev environment for the rest of the team.
 */
export function ServerMockEditor({
  rule,
  saving,
  sampleBody,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  rule: ServerMockRule;
  saving: boolean;
  /** The captured real response, offered as the start of "Use my own answer". */
  sampleBody?: string | null;
  onChange: (rule: ServerMockRule) => void;
  /** `enable` true saves and switches the rule on in one step. */
  onSave: (enable: boolean) => void;
  onCancel: () => void;
  onDelete?: () => void;
}): JSX.Element {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const patch = (changes: Partial<ServerMockRule>): void => onChange({ ...rule, ...changes, updatedAt: Date.now() });
  const patchMatch = (changes: Partial<ServerMockRule['match']>): void => patch({ match: { ...rule.match, ...changes } });
  const patchAction = (changes: Partial<ServerMockRule['action']>): void => patch({ action: { ...rule.action, ...changes } });

  const needsBody = rule.action.type === 'status-code' || rule.action.type === 'custom-body';
  const needsMutations = rule.action.type === 'passthrough-mutate';
  const scenario = activeScenario(rule);
  const chosen = SERVER_MOCK_PRESETS.find((preset) => preset.id === scenario);
  const simpleRepeat = REPEAT_OPTIONS.some((option) => option.id === rule.applyMode);
  const canSave = !saving && Boolean(rule.match.urlPattern);

  function useOwnAnswer(): void {
    onChange({
      ...rule,
      name: `${rule.match.method} ${rule.match.urlPattern} → my answer`,
      action: { type: 'custom-body', statusCode: 200, body: sampleBody || JSON.stringify({ example: 'Edit this answer' }, null, 2) },
      updatedAt: Date.now(),
    });
  }

  return (
    <form
      className="mock-editor simple"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(true);
      }}
    >
      <header>
        <div>
          <span className="overline">SIMULATE A PROBLEM</span>
          <h3>{rule.name || 'New server rule'}</h3>
        </div>
        <span className={`badge ${rule.enabled ? 'mock' : ''}`}>{rule.enabled ? 'On' : 'Off'}</span>
      </header>

      <section className="mock-step">
        <h4><b>1</b> Which call?</h4>
        <p className="target-sentence">
          When the server makes <strong className="mono">{describeRuleTarget(rule)}</strong>, ApiLens answers instead of the real backend.
        </p>
      </section>

      <section className="mock-step">
        <h4><b>2</b> What should go wrong?</h4>
        <div className="scenario-grid" role="radiogroup" aria-label="What should go wrong">
          {SERVER_MOCK_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={scenario === preset.id}
              className={`scenario-card ${scenario === preset.id ? 'active' : ''}`}
              title={preset.hint}
              onClick={() => onChange(preset.apply(rule))}
            >
              <strong>{preset.title}</strong>
              <span>{preset.effect}</span>
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={scenario === 'custom'}
            className={`scenario-card ${scenario === 'custom' ? 'active' : ''}`}
            onClick={useOwnAnswer}
          >
            <strong>Use my own answer</strong>
            <span>{sampleBody ? 'Start from the real answer and change the values you need.' : 'Type the answer the backend should give.'}</span>
          </button>
        </div>
        {chosen ? <p className="expect-note"><strong>What to check:</strong> {chosen.expect}</p> : null}
        {scenario === 'custom' ? (
          <Field label="The answer the backend will give" hint="Change values such as amounts, dates or statuses, then save">
            <textarea className="input code" rows={8} value={rule.action.body ?? ''} onChange={(event) => patchAction({ body: event.target.value })} />
          </Field>
        ) : null}
      </section>

      <section className="mock-step">
        <h4><b>3</b> How many times?</h4>
        <div className="repeat-options" role="radiogroup" aria-label="How many times">
          {REPEAT_OPTIONS.map((option) => (
            <label key={option.id} className={`repeat-option ${rule.applyMode === option.id ? 'active' : ''}`}>
              <input type="radio" name="repeat" checked={rule.applyMode === option.id} onChange={() => patch({ applyMode: option.id })} />
              <span><strong>{option.title}</strong><small>{option.hint}</small></span>
            </label>
          ))}
        </div>
        {!simpleRepeat ? <p className="muted">A custom count is set under Developer options.</p> : null}
      </section>

      <details className="dev-options" open={showAdvanced} onToggle={(event) => setShowAdvanced(event.currentTarget.open)}>
        <summary>Developer options <span className="muted">— address matching, status code, delay, headers</span></summary>
        <div className="field-grid">
          <Field label="Rule name">
            <input className="input" value={rule.name} onChange={(event) => patch({ name: event.target.value })} required maxLength={200} />
          </Field>

          <Field label="Applies to" hint="Outbound calls are what a BFF makes to upstream services">
            <select className="input" value={rule.match.kind} onChange={(event) => patchMatch({ kind: event.target.value as ServerMockRule['match']['kind'] })}>
              <option value="client">Outbound upstream calls</option>
              <option value="server">Incoming API routes</option>
              <option value="any">Both</option>
            </select>
          </Field>

          <Field label="Method">
            <select className="input" value={rule.match.method} onChange={(event) => patchMatch({ method: event.target.value })}>
              {['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => (
                <option key={method} value={method}>{method}</option>
              ))}
            </select>
          </Field>

          <Field label="Match type">
            <select className="input" value={rule.match.matchType} onChange={(event) => patchMatch({ matchType: event.target.value as ServerMockRule['match']['matchType'] })}>
              <option value="glob">Glob (*)</option>
              <option value="contains">Contains</option>
              <option value="startsWith">Starts with</option>
              <option value="equals">Exact</option>
              <option value="regex">Regex</option>
            </select>
          </Field>

          <Field label="URL pattern" hint="Keep it narrow — this runs inside a shared server">
            <input className="input mono" value={rule.match.urlPattern} onChange={(event) => patchMatch({ urlPattern: event.target.value })} required placeholder="*/api/billing/*" />
          </Field>

          <Field label="Behaviour">
            <select className="input" value={rule.action.type} onChange={(event) => patchAction({ type: event.target.value as ServerMockRule['action']['type'] })}>
              {ACTION_LABELS.map((action) => (
                <option key={action.id} value={action.id}>{action.label}</option>
              ))}
            </select>
          </Field>

          {needsBody ? (
            <Field label="Status code">
              <input
                className="input"
                type="number"
                min={100}
                max={599}
                value={rule.action.statusCode ?? 503}
                onChange={(event) => patchAction({ statusCode: Number(event.target.value) })}
              />
            </Field>
          ) : null}

          <Field label="Added latency (ms)" hint="Applied before the response is produced">
            <input
              className="input"
              type="number"
              min={0}
              max={120000}
              step={100}
              value={rule.action.delayMs ?? 0}
              onChange={(event) => patchAction({ delayMs: Number(event.target.value) })}
            />
          </Field>

          <Field label="Apply mode">
            <select className="input" value={rule.applyMode} onChange={(event) => patch({ applyMode: event.target.value as ServerMockRule['applyMode'] })}>
              <option value="always">Every matching call</option>
              <option value="once">Once, then stop</option>
              <option value="n-times">First N calls</option>
              <option value="after-n">Only after N calls</option>
            </select>
          </Field>

          {rule.applyMode === 'n-times' || rule.applyMode === 'after-n' ? (
            <Field label="N">
              <input className="input" type="number" min={0} value={rule.applyLimit ?? 1} onChange={(event) => patch({ applyLimit: Number(event.target.value) })} />
            </Field>
          ) : null}

          <Field label="Request body contains" hint="Only matches when the payload was captured">
            <input className="input" value={rule.match.bodyContains ?? ''} onChange={(event) => patchMatch({ bodyContains: event.target.value || undefined })} />
          </Field>
          <Field label="Header name">
            <input className="input" value={rule.match.headerName ?? ''} onChange={(event) => patchMatch({ headerName: event.target.value || undefined })} />
          </Field>
          <Field label="Header contains">
            <input className="input" value={rule.match.headerValue ?? ''} onChange={(event) => patchMatch({ headerValue: event.target.value || undefined })} />
          </Field>
          <Field label="Priority" hint="Lower wins">
            <input className="input" type="number" value={rule.priority} onChange={(event) => patch({ priority: Number(event.target.value) })} />
          </Field>
        </div>

        {needsBody && scenario !== 'custom' ? (
          <Field label="Response body">
            <textarea
              className="input code"
              rows={6}
              value={rule.action.body ?? ''}
              onChange={(event) => patchAction({ body: event.target.value })}
              placeholder='{"error":"Service unavailable"}'
            />
          </Field>
        ) : null}

        {needsMutations ? (
          <Field label="Field mutations" hint="One per line: path operation [value] — e.g. data.amountDue nullify">
            <textarea
              className="input code"
              rows={4}
              value={(rule.action.fieldMutations ?? []).map((mutation) => `${mutation.path} ${mutation.operation}${mutation.value === undefined ? '' : ` ${JSON.stringify(mutation.value)}`}`).join('\n')}
              onChange={(event) => patchAction({ fieldMutations: parseMutations(event.target.value) })}
              placeholder={'data.items[0].amountDue nullify\ndata.status set "SUSPENDED"'}
            />
          </Field>
        ) : null}
      </details>

      <footer className="editor-actions">
        <button type="submit" className="btn primary" disabled={!canSave}>{saving ? 'Saving…' : 'Save and turn on'}</button>
        <button type="button" className="btn" disabled={!canSave} onClick={() => onSave(false)}>Save, keep off</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        {onDelete ? <button type="button" className="btn danger" onClick={onDelete}>Delete</button> : null}
        <span className="muted">Then repeat the step in the app and check the page.</span>
      </footer>
    </form>
  );
}

/** Parses the newline-based mutation shorthand shown in the editor. */
export function parseMutations(source: string): ServerMockRule['action']['fieldMutations'] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [path, operation = 'set', ...rest] = line.split(/\s+/);
      const raw = rest.join(' ');
      let value: unknown;
      if (raw) {
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
      }
      const normalised = ['set', 'delete', 'nullify', 'changeType'].includes(operation) ? operation : 'set';
      return { path: path!, operation: normalised as 'set' | 'delete' | 'nullify' | 'changeType', value };
    })
    .filter((mutation) => Boolean(mutation.path));
}
