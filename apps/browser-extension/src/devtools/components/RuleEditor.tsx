import React, { useState, useEffect } from 'react';
import { Rule, MatchCondition, RuleAction, FailureType } from '@apilens/shared-types';

interface RuleEditorProps {
  rule?: Rule;
  onSave: (rule: Rule) => void;
  onCancel: () => void;
}

const FAILURE_TYPES: FailureType[] = [
  'status-code', 'connection-reset', 'timeout', 'dns-failure', 'empty-response',
  'invalid-json', 'truncated-json', 'slow-response', 'missing-field', 'null-field',
  'wrong-type', 'malformed-headers', 'websocket-disconnect', 'sse-interrupt',
  'rate-limit', 'custom-body'
];

export const RuleEditor: React.FC<RuleEditorProps> = ({ rule, onSave, onCancel }) => {
  const [name, setName] = useState(rule?.name || '');
  const [description, setDescription] = useState(rule?.description || '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [priority, setPriority] = useState(rule?.priority || 1);
  const [conditionLogic, setConditionLogic] = useState<'and' | 'or'>(rule?.conditionLogic || 'and');
  const [conditions, setConditions] = useState<MatchCondition[]>(rule?.conditions || []);
  const [action, setAction] = useState<RuleAction>(rule?.action || { type: 'status-code', statusCode: 500 });
  const [applyMode, setApplyMode] = useState(rule?.applyMode || 'always');
  const [applyLimit, setApplyLimit] = useState(rule?.applyLimit || 1);
  const [applyProbability, setApplyProbability] = useState(rule?.applyProbability || 50);

  const handleSave = () => {
    const newRule: Rule = {
      id: rule?.id || crypto.randomUUID(),
      scenarioId: rule?.scenarioId || '',
      name,
      description,
      enabled,
      priority,
      conditions,
      conditionLogic,
      action,
      applyMode,
      applyLimit: applyMode === 'n-times' ? applyLimit : undefined,
      applyProbability: applyMode === 'probability' ? applyProbability : undefined,
      appliedCount: rule?.appliedCount || 0,
      createdAt: rule?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    onSave(newRule);
  };

  const addCondition = () => {
    setConditions([...conditions, { field: 'url', operator: 'contains', value: '' }]);
  };

  const updateCondition = (index: number, updates: Partial<MatchCondition>) => {
    const newConditions = [...conditions];
    newConditions[index] = { ...newConditions[index], ...updates };
    setConditions(newConditions);
  };

  const removeCondition = (index: number) => {
    setConditions(conditions.filter((_, i) => i !== index));
  };

  return (
    <div className="rule-editor">
      <h3>{rule ? 'Edit Rule' : 'New Rule'}</h3>
      <div className="form-group">
        <label>Name</label>
        <input className="input-md" value={name} onChange={e => setName(e.target.value)} placeholder="Rule Name" />
      </div>
      <div className="form-group">
        <label>Description</label>
        <input className="input-md" value={description} onChange={e => setDescription(e.target.value)} placeholder="Description" />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>Priority</label>
          <input className="input-md" type="number" value={priority} onChange={e => setPriority(Number(e.target.value))} />
        </div>
        <div className="form-group">
          <label>Enabled</label>
          <label className="toggle-switch">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>

      <h4>Match Conditions</h4>
      <div className="condition-logic-toggle">
        <button className={`logic-btn ${conditionLogic === 'and' ? 'active' : ''}`} onClick={() => setConditionLogic('and')}>AND</button>
        <button className={`logic-btn ${conditionLogic === 'or' ? 'active' : ''}`} onClick={() => setConditionLogic('or')}>OR</button>
      </div>
      {conditions.map((cond, i) => (
        <div key={i} className="condition-row">
          <select value={cond.field} onChange={e => updateCondition(i, { field: e.target.value as any })}>
            <option value="url">URL</option>
            <option value="path">Path</option>
            <option value="method">Method</option>
            <option value="hostname">Hostname</option>
            <option value="query">Query</option>
            <option value="header">Header</option>
            <option value="body">Body</option>
            <option value="graphqlOperation">GraphQL Op</option>
            <option value="serviceName">Service Name</option>
          </select>
          {(cond.field === 'header' || cond.field === 'query') && (
            <input className="input-sm" placeholder="Key" value={cond.key || ''} onChange={e => updateCondition(i, { key: e.target.value })} />
          )}
          <select value={cond.operator} onChange={e => updateCondition(i, { operator: e.target.value as any })}>
            <option value="equals">Equals</option>
            <option value="contains">Contains</option>
            <option value="startsWith">Starts With</option>
            <option value="endsWith">Ends With</option>
            <option value="regex">Regex</option>
            <option value="exists">Exists</option>
            <option value="notExists">Not Exists</option>
          </select>
          <input className="input-md" placeholder="Value" value={cond.value || ''} onChange={e => updateCondition(i, { value: e.target.value })} />
          <button className="btn btn-danger btn-sm" onClick={() => removeCondition(i)}>X</button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={addCondition}>+ Add Condition</button>

      <h4>Action</h4>
      <div className="form-group">
        <label>Failure Type</label>
        <select className="input-md" value={action.type} onChange={e => setAction({ ...action, type: e.target.value as FailureType })}>
          {FAILURE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {(action.type === 'status-code' || action.type === 'custom-body') && (
        <>
          <div className="form-group">
            <label>Status Code</label>
            <input className="input-md" type="number" value={action.statusCode || ''} onChange={e => setAction({ ...action, statusCode: Number(e.target.value) })} />
          </div>
          <div className="form-group">
            <label>Response Body</label>
            <textarea className="input-md" value={action.responseBody || ''} onChange={e => setAction({ ...action, responseBody: e.target.value })} />
          </div>
        </>
      )}
      <div className="form-group">
        <label>Delay (ms)</label>
        <input className="input-md" type="number" value={action.delayMs || ''} onChange={e => setAction({ ...action, delayMs: Number(e.target.value) })} />
      </div>

      <h4>Apply Mode</h4>
      <div className="apply-mode-group">
        <label className="radio-option"><input type="radio" checked={applyMode === 'always'} onChange={() => setApplyMode('always')} /> Always</label>
        <label className="radio-option"><input type="radio" checked={applyMode === 'once'} onChange={() => setApplyMode('once')} /> Once</label>
        <label className="radio-option"><input type="radio" checked={applyMode === 'n-times'} onChange={() => setApplyMode('n-times')} /> N-Times</label>
        <label className="radio-option"><input type="radio" checked={applyMode === 'probability'} onChange={() => setApplyMode('probability')} /> Probability</label>
      </div>
      {applyMode === 'n-times' && <input className="input-sm" type="number" value={applyLimit} onChange={e => setApplyLimit(Number(e.target.value))} />}
      {applyMode === 'probability' && <input className="input-sm" type="number" value={applyProbability} onChange={e => setApplyProbability(Number(e.target.value))} placeholder="%" />}

      <div className="form-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave}>Save Rule</button>
      </div>
    </div>
  );
};
