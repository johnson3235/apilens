import React, { useState, useEffect } from 'react';
import { Rule, Scenario } from '@apilens/shared-types';
import { RuleEditor } from './RuleEditor';

interface ScenarioBuilderProps {
  rules: Rule[];
  onAddRule: (rule: Rule) => void;
  onRemoveRule: (id: string) => void;
  onToggleRule: (id: string) => void;
}

export const ScenarioBuilder: React.FC<ScenarioBuilderProps> = ({ rules, onAddRule, onRemoveRule, onToggleRule }) => {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [showRuleEditor, setShowRuleEditor] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(['scenarios'], (res) => {
      if (res.scenarios) setScenarios(res.scenarios);
    });
  }, []);

  const saveScenarios = (newScenarios: Scenario[]) => {
    setScenarios(newScenarios);
    chrome.storage.local.set({ scenarios: newScenarios });
  };

  const createScenario = () => {
    const newScenario: Scenario = {
      id: crypto.randomUUID(),
      projectId: 'local',
      name: 'New Scenario',
      description: '',
      status: 'draft',
      rules: [],
      tags: [],
      version: 1,
      createdBy: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    saveScenarios([...scenarios, newScenario]);
    setSelectedScenarioId(newScenario.id);
  };

  const selectedScenario = scenarios.find(s => s.id === selectedScenarioId);
  const scenarioRules = rules.filter(r => selectedScenario?.rules.includes(r.id));

  const updateScenario = (updates: Partial<Scenario>) => {
    if (!selectedScenarioId) return;
    saveScenarios(scenarios.map(s => s.id === selectedScenarioId ? { ...s, ...updates, updatedAt: Date.now() } : s));
  };

  const handleSaveRule = (rule: Rule) => {
    rule.scenarioId = selectedScenarioId || '';
    onAddRule(rule);
    if (selectedScenarioId && !selectedScenario?.rules.includes(rule.id)) {
      updateScenario({ rules: [...(selectedScenario?.rules || []), rule.id] });
    }
    setShowRuleEditor(false);
    setEditingRule(null);
  };

  const deleteScenario = (id: string) => {
    if (confirm('Delete scenario?')) {
      saveScenarios(scenarios.filter(s => s.id !== id));
      if (selectedScenarioId === id) setSelectedScenarioId(null);
    }
  };

  const exportPlaywright = () => {
    if (!selectedScenario) return;
    let code = `// Playwright mock for ${selectedScenario.name}\n`;
    scenarioRules.forEach(r => {
      if (r.action.type === 'status-code' || r.action.type === 'custom-body') {
        const urlCond = r.conditions.find(c => c.field === 'url' || c.field === 'path');
        const urlStr = urlCond ? `**/*${urlCond.value}*` : '**/*';
        code += `await page.route('${urlStr}', async route => {\n  await route.fulfill({\n    status: ${r.action.statusCode || 200},\n    body: ${JSON.stringify(r.action.responseBody || '')}\n  });\n});\n`;
      }
    });
    console.log(code);
    alert('Code logged to console!');
  };

  return (
    <div className="scenario-builder">
      <div className="scenarios-list">
        <button className="btn btn-primary" onClick={createScenario} style={{ width: '100%', marginBottom: 16 }}>+ New Scenario</button>
        {scenarios.map(s => (
          <div key={s.id} onClick={() => setSelectedScenarioId(s.id)} style={{ padding: '8px', cursor: 'pointer', background: s.id === selectedScenarioId ? 'var(--bg-hover)' : '', borderRadius: 4, marginBottom: 4 }}>
            <div style={{ fontWeight: 'bold' }}>{s.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Status: {s.status}</div>
          </div>
        ))}
      </div>
      <div className="rules-list">
        {selectedScenario ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <input className="input-md" value={selectedScenario.name} onChange={e => updateScenario({ name: e.target.value })} style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 8 }} />
                <input className="input-md" value={selectedScenario.description} onChange={e => updateScenario({ description: e.target.value })} placeholder="Description" />
              </div>
              <div style={{ display: 'flex', gap: 8, flexDirection: 'column' }}>
                <select className="input-md" value={selectedScenario.status} onChange={e => updateScenario({ status: e.target.value as any })}>
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm" onClick={exportPlaywright}>Export Playwright</button>
                  <button className="btn btn-sm btn-danger" onClick={() => deleteScenario(selectedScenario.id)}>Delete</button>
                </div>
              </div>
            </div>
            
            <hr style={{ borderColor: 'var(--border)', margin: '16px 0' }} />
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h4>Rules ({scenarioRules.length})</h4>
              <button className="btn btn-sm btn-primary" onClick={() => { setEditingRule(null); setShowRuleEditor(true); }}>+ Add Rule</button>
            </div>

            {showRuleEditor ? (
              <RuleEditor rule={editingRule || undefined} onSave={handleSaveRule} onCancel={() => setShowRuleEditor(false)} />
            ) : (
              <div>
                {scenarioRules.map(r => (
                  <div key={r.id} style={{ padding: 12, background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong>{r.name}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Priority: {r.priority}</span>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.action.type}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label className="toggle-switch">
                        <input type="checkbox" checked={r.enabled} onChange={() => onToggleRule(r.id)} />
                        <span className="toggle-slider"></span>
                      </label>
                      <button className="btn btn-sm" onClick={() => { setEditingRule(r); setShowRuleEditor(true); }}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={() => onRemoveRule(r.id)}>X</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">Select a scenario or create a new one</div>
        )}
      </div>
    </div>
  );
};
