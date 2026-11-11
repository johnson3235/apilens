import { useState, type ReactNode } from 'react';
import type { Rule } from '@apilens/shared-types';
import type { ServerMockRule } from '../../shared/server-control';
import { Icon } from '../components/Icon';
import { ServerMockEditor, blankServerRule, serverRuleSentence } from '../components/ServerMockEditor';
import type { ServerData } from '../hooks/useServerData';

/**
 * Every simulated problem in one place, browser and server side by side.
 *
 * A mock left on is the classic way a shared test environment gets confusing
 * for the next person, so this screen answers "what is being faked right
 * now?" first and makes switching everything off one click.
 */
export function MocksView({
  browserRules,
  browserBusy,
  browserBlockedReason,
  browserHealth,
  onToggleBrowserRule,
  onTurnOffBrowserRules,
  onRepair,
  server,
  onNotice,
  onOpenBrowserCalls,
  onOpenServerCalls,
}: {
  browserRules: Rule[];
  browserBusy: string | null;
  browserBlockedReason: string | null;
  /** The browser engine's readiness checks, rendered by the panel. */
  browserHealth: ReactNode;
  onToggleBrowserRule: (rule: Rule) => void;
  onTurnOffBrowserRules: () => void;
  onRepair: () => void;
  server: ServerData;
  onNotice: (message: string) => void;
  onOpenBrowserCalls: () => void;
  onOpenServerCalls: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ServerMockRule | null>(null);
  const [saving, setSaving] = useState(false);
  const activeBrowser = browserRules.filter((rule) => rule.enabled).length;
  const activeServer = server.rules.filter((rule) => rule.enabled).length;
  const mockingBlocked = server.status?.health && !server.status.health.mockingEnabled;

  async function persist(rules: ServerMockRule[], message: string): Promise<void> {
    setSaving(true);
    try {
      await server.saveRules(rules);
      onNotice(message);
      setDraft(null);
    } catch (caught) {
      onNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  if (draft) {
    return (
      <div className="page mocks-view">
        <div className="page-head">
          <button className="btn ghost sm" onClick={() => setDraft(null)}>← All mocks</button>
          <h1>{server.rules.some((rule) => rule.id === draft.id) ? 'Edit server mock' : 'New server mock'}</h1>
        </div>
        <div className="page-scroll">
          <ServerMockEditor
            rule={draft}
            saving={saving}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={(enable) => {
              const saved = { ...draft, enabled: enable, updatedAt: Date.now() };
              void persist([...server.rules.filter((rule) => rule.id !== draft.id), saved],
                enable ? `“${saved.name}” is on. Repeat the step in the app now.` : `“${saved.name}” saved and kept off.`);
            }}
            onDelete={server.rules.some((rule) => rule.id === draft.id)
              ? () => void persist(server.rules.filter((rule) => rule.id !== draft.id), `“${draft.name}” removed.`)
              : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page mocks-view">
      <div className="page-head">
        <h1>Mocks</h1>
        <span className="sub">
          {activeBrowser + activeServer
            ? `${activeBrowser + activeServer} simulated problem${activeBrowser + activeServer === 1 ? ' is' : 's are'} on — turn them off when you finish.`
            : 'Make a call fail on purpose to check the page copes. Nothing is faked right now.'}
        </span>
        <div className="actions">
          {activeBrowser + activeServer ? (
            <button
              className="btn danger"
              disabled={saving}
              onClick={() => {
                if (activeBrowser) onTurnOffBrowserRules();
                if (activeServer) void persist(server.rules.map((rule) => ({ ...rule, enabled: false, updatedAt: Date.now() })), 'All server mocks are off.');
              }}
            >
              Turn all off ({activeBrowser + activeServer})
            </button>
          ) : null}
        </div>
      </div>

      <div className="page-scroll">
        <div className="mock-columns">
          <section className="mock-section" aria-labelledby="server-mocks-title">
            <header>
              <Icon name="server" />
              <div>
                <h2 id="server-mocks-title">On the server</h2>
                <p>A backend the app’s server calls answers the way you choose. Shared by everyone on that server.</p>
              </div>
              <div className="actions">
                <button className="btn sm" disabled={!server.status?.connected || Boolean(mockingBlocked)} onClick={() => setDraft(blankServerRule(server.status?.health?.serviceName ?? 'server'))}>New</button>
              </div>
            </header>
            {mockingBlocked ? <div className="notice warn"><Icon name="alert" /><div><strong>Server mocks are disabled for this deployment.</strong><span> allowMockControl is false in the app’s SDK config.</span></div></div> : null}
            <div className="list">
              {server.rules.length === 0 ? (
                <div className="mock-empty">
                  <strong>No server mocks</strong>
                  Open Server calls, pick a backend call, then “Simulate a problem”. Starting from a real call keeps the mock narrow.
                  <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><button className="btn sm" onClick={onOpenServerCalls}>Open Server calls</button></div>
                </div>
              ) : server.rules.map((rule) => (
                <article className={`mock-card rule-card ${rule.enabled ? '' : 'off'}`} key={rule.id}>
                  <button
                    className={`switch ${rule.enabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} ${rule.name}`}
                    disabled={saving}
                    onClick={() => void persist(
                      server.rules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item)),
                      `${rule.name} ${rule.enabled ? 'is off' : 'is on'}.`,
                    )}
                  ><span /></button>
                  <div className="name">
                    <strong>{rule.name}</strong>
                    {rule.enabled ? <span className="tag mock">On</span> : <span className="tag outline">Off</span>}
                    <span className="tag outline">{rule.applyMode === 'once' ? 'next call only' : rule.applyMode === 'always' ? 'every call' : rule.applyMode}</span>
                  </div>
                  <div className="used">used <b>{rule.appliedCount}</b> <button className="btn ghost sm" onClick={() => setDraft(rule)}>Edit</button></div>
                  <p>{serverRuleSentence(rule)}</p>
                  <code>{rule.match.urlPattern}</code>
                </article>
              ))}
            </div>
          </section>

          <section className="mock-section" aria-labelledby="browser-mocks-title">
            <header>
              <Icon name="globe" />
              <div>
                <h2 id="browser-mocks-title">In the browser</h2>
                <p>A request this tab makes is answered by ApiLens instead of the network. Only you see it.</p>
              </div>
              <div className="actions">
                <button className="btn sm" onClick={onRepair}>Repair &amp; test</button>
              </div>
            </header>
            {browserBlockedReason ? <div className="notice err"><Icon name="alert" /><div><strong>Browser mocks are blocked here.</strong><span> {browserBlockedReason}</span></div></div> : null}
            <div className="list">
              {browserRules.length === 0 ? (
                <div className="mock-empty">
                  <strong>No browser mocks</strong>
                  Open Browser calls, select the exact request, then choose Create mock.
                  <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}><button className="btn sm" onClick={onOpenBrowserCalls}>Open Browser calls</button></div>
                </div>
              ) : browserRules.map((rule) => (
                <article className={`mock-card rule-card ${rule.enabled ? '' : 'off'}`} key={rule.id}>
                  <button
                    className={`switch ${rule.enabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={rule.enabled}
                    aria-label={`${rule.enabled ? 'Turn off' : 'Turn on'} ${rule.name}`}
                    onClick={() => onToggleBrowserRule(rule)}
                    disabled={browserBusy === `rule-${rule.id}`}
                  ><span /></button>
                  <div className="name">
                    <strong>{rule.name}</strong>
                    {rule.enabled ? <span className="tag mock">On</span> : <span className="tag outline">Off</span>}
                    <span className="tag outline">{rule.action.type}</span>
                  </div>
                  <div className="used">used <b>{rule.appliedCount}</b></div>
                  <p>{rule.description || `${rule.conditions.length} match condition${rule.conditions.length === 1 ? '' : 's'}`}</p>
                  <code>{rule.conditions.map((condition) => `${condition.field} ${condition.operator} ${condition.value}`).join(' · ')}</code>
                </article>
              ))}
            </div>
            <details className="engine-details">
              <summary>Browser mock engine checks</summary>
              {browserHealth}
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}
