import React, { useState, useEffect } from 'react';
import { CapturedRequest } from '@apilens/shared-types';
import { 
  ValidationRule, 
  loadValidationRules, 
  saveValidationRules, 
  validateCapturedRequest, 
  generateAutomationTestSpec 
} from '../../shared/validator';

interface ResponseValidatorProps {
  requests: CapturedRequest[];
}

export const ResponseValidator: React.FC<ResponseValidatorProps> = ({ requests }) => {
  const [rules, setRules] = useState<ValidationRule[]>([]);
  const [selectedReq, setSelectedReq] = useState<CapturedRequest | null>(null);
  const [testFramework, setTestFramework] = useState<'playwright' | 'cypress' | 'postman' | 'jest'>('playwright');
  const [copiedSpec, setCopiedSpec] = useState<boolean>(false);

  // New Rule Form State
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [newRuleName, setNewRuleName] = useState<string>('');
  const [newUrlKeyword, setNewUrlKeyword] = useState<string>('');
  const [newExpectedStatus, setNewExpectedStatus] = useState<number>(200);
  const [newMaxDuration, setNewMaxDuration] = useState<number>(1500);
  const [newRequiredFields, setNewRequiredFields] = useState<string>('');

  useEffect(() => {
    loadValidationRules().then(r => setRules(r));
    if (requests.length > 0 && !selectedReq) {
      setSelectedReq(requests[0]);
    }
  }, [requests]);

  const handleAddValidationRule = () => {
    if (!newRuleName.trim() || !newUrlKeyword.trim()) {
      alert('Please enter a Rule Name and URL Keyword!');
      return;
    }
    const fields = newRequiredFields.split(',').map(f => f.trim()).filter(Boolean);
    const newRule: ValidationRule = {
      id: crypto.randomUUID(),
      name: newRuleName.trim(),
      urlKeyword: newUrlKeyword.trim(),
      expectedStatus: newExpectedStatus,
      maxDurationMs: newMaxDuration,
      requiredFields: fields.length > 0 ? fields : undefined,
      requiredHeaders: ['content-type'],
      enabled: true
    };
    const updated = [...rules, newRule];
    setRules(updated);
    saveValidationRules(updated);
    setShowAddForm(false);
    setNewRuleName('');
    setNewUrlKeyword('');
  };

  const handleToggleRule = (id: string) => {
    const updated = rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
    setRules(updated);
    saveValidationRules(updated);
  };

  const handleDeleteRule = (id: string) => {
    const updated = rules.filter(r => r.id !== id);
    setRules(updated);
    saveValidationRules(updated);
  };

  const handleCopySpec = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedSpec(true);
    setTimeout(() => setCopiedSpec(false), 2000);
  };

  const handleDownloadSpec = (code: string, path?: string) => {
    const fileName = `test-${(path || 'api').replace(/[^a-zA-Z0-9]/g, '-')}.${testFramework === 'playwright' ? 'spec.ts' : testFramework === 'cypress' ? 'cy.ts' : 'js'}`;
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Run validation on selected request
  const validationResults = selectedReq ? validateCapturedRequest(selectedReq, rules) : [];
  const specCode = selectedReq ? generateAutomationTestSpec(selectedReq, testFramework) : '';

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', background: 'var(--bg-dark)' }}>
      {/* Left List Pane: Requests & Validation Status */}
      <div style={{ width: '340px', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '10px 12px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 800, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            🧪 QA Response Validator
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => setShowAddForm(true)}>
            + Add Validation
          </button>
        </div>

        {/* Requests List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {requests.length === 0 ? (
            <div className="empty-state">No captured requests to validate.</div>
          ) : (
            requests.map(req => {
              const resList = validateCapturedRequest(req, rules);
              const hasErrors = resList.some(r => !r.passed);
              const hasWarnings = resList.some(r => r.warnings.length > 0);

              return (
                <div 
                  key={req.id}
                  onClick={() => setSelectedReq(req)}
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    background: req.id === selectedReq?.id ? 'var(--bg-hover)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                >
                  <div style={{ overflow: 'hidden', marginRight: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className={`method-${req.method.toLowerCase()}`} style={{ fontWeight: 800, fontSize: '10px' }}>
                        {req.method}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {req.path || req.url}
                      </span>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      Status: {req.statusCode || 'ERR'} | {req.durationMs ? `${req.durationMs}ms` : 'pending'}
                    </div>
                  </div>

                  <div>
                    {hasErrors ? (
                      <span style={{ background: 'rgba(255,23,68,0.2)', color: '#FF1744', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 800 }}>
                        ❌ FAILED
                      </span>
                    ) : hasWarnings ? (
                      <span style={{ background: 'rgba(255,234,0,0.15)', color: 'var(--accent-yellow)', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 800 }}>
                        ⚠️ SLA
                      </span>
                    ) : (
                      <span style={{ background: 'rgba(0,230,118,0.15)', color: 'var(--accent-green)', padding: '2px 6px', borderRadius: '4px', fontSize: '10px', fontWeight: 800 }}>
                        ✓ PASSED
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Details Pane: Validation Breakdown & Automation Spec Export */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-card)', overflowY: 'auto' }}>
        {showAddForm ? (
          <div style={{ padding: '20px' }}>
            <h3 style={{ marginBottom: '16px', color: 'var(--text-main)' }}>Add QA Contract Validation Rule</h3>
            <div className="filter-card">
              <div className="form-group">
                <label>Rule Name</label>
                <input className="input-sm" placeholder="e.g. User API Contract & SLA Check" value={newRuleName} onChange={e => setNewRuleName(e.target.value)} />
              </div>
              <div className="form-group">
                <label>URL Keyword Match</label>
                <input className="input-sm" placeholder="e.g. /api/v1/users or checkout" value={newUrlKeyword} onChange={e => setNewUrlKeyword(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Expected Status Code</label>
                  <input className="input-sm" type="number" value={newExpectedStatus} onChange={e => setNewExpectedStatus(Number(e.target.value))} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Max Latency SLA (ms)</label>
                  <input className="input-sm" type="number" value={newMaxDuration} onChange={e => setNewMaxDuration(Number(e.target.value))} />
                </div>
              </div>
              <div className="form-group">
                <label>Required JSON Fields (Comma separated)</label>
                <input className="input-sm" placeholder="e.g. id, status, data.user.email" value={newRequiredFields} onChange={e => setNewRequiredFields(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowAddForm(false)}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleAddValidationRule}>Save Rule</button>
              </div>
            </div>
          </div>
        ) : selectedReq ? (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Header info */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
              <div>
                <span className={`method-${selectedReq.method.toLowerCase()}`} style={{ fontWeight: 800, marginRight: '8px' }}>
                  {selectedReq.method}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 700 }}>
                  {selectedReq.url}
                </span>
              </div>
              <span className={`status-badge ${selectedReq.statusCode && selectedReq.statusCode < 400 ? 'status-green' : 'status-red'}`}>
                {selectedReq.statusCode || 'ERR'} ({selectedReq.durationMs}ms)
              </span>
            </div>

            {/* Validation Matrix Results */}
            <div>
              <h4 style={{ fontSize: '12px', uppercase: true, color: 'var(--text-muted)', marginBottom: '8px' }}>
                Contract Validation Matrix Results
              </h4>
              {validationResults.length === 0 ? (
                <div style={{ padding: '12px', background: 'var(--bg-dark)', borderRadius: '6px', border: '1px dashed var(--border)', fontSize: '12px', color: 'var(--text-muted)' }}>
                  No active validation rules match this request URL. Click "+ Add Validation" to enforce contracts!
                </div>
              ) : (
                validationResults.map((res, idx) => (
                  <div key={idx} style={{ padding: '12px', background: 'var(--bg-dark)', borderRadius: '8px', border: `1px solid ${res.passed ? 'rgba(0,230,118,0.3)' : 'rgba(255,23,68,0.4)'}`, marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <strong style={{ color: 'var(--text-main)' }}>{res.ruleName}</strong>
                      <span style={{ color: res.passed ? 'var(--accent-green)' : '#FF1744', fontWeight: 800, fontSize: '11px' }}>
                        {res.passed ? '✓ PASSED' : '❌ CONTRACT ERROR'}
                      </span>
                    </div>

                    {res.errors.map((err, i) => (
                      <div key={i} style={{ color: '#FF1744', fontSize: '11px', marginTop: '2px' }}>
                        • {err}
                      </div>
                    ))}
                    {res.warnings.map((warn, i) => (
                      <div key={i} style={{ color: 'var(--accent-yellow)', fontSize: '11px', marginTop: '2px' }}>
                        • {warn}
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>

            {/* Response Body Code Viewer */}
            <div>
              <h4 style={{ fontSize: '12px', uppercase: true, color: 'var(--text-muted)', marginBottom: '8px' }}>
                Actual Response Body Payload
              </h4>
              <pre style={{ background: 'var(--bg-dark)', padding: '12px', borderRadius: '6px', maxHeight: '160px', overflow: 'auto', fontFamily: 'monospace', fontSize: '11px', color: 'var(--accent-green)' }}>
                {typeof selectedReq.responseBody === 'string' ? selectedReq.responseBody : JSON.stringify(selectedReq.responseBody, null, 2) || 'No response body captured'}
              </pre>
            </div>

            {/* Test Code Generator */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ fontSize: '12px', uppercase: true, color: 'var(--text-muted)' }}>
                  1-Click Automation Test Code Generator
                </h4>
                <div style={{ display: 'flex', gap: '4px' }}>
                  {(['playwright', 'cypress', 'postman', 'jest'] as const).map(fw => (
                    <button 
                      key={fw}
                      className={`btn btn-sm ${testFramework === fw ? 'btn-primary' : ''}`}
                      onClick={() => setTestFramework(fw)}
                      style={{ fontSize: '10px', textTransform: 'capitalize' }}
                    >
                      {fw}
                    </button>
                  ))}
                </div>
              </div>

              <pre style={{ background: 'var(--bg-dark)', padding: '12px', borderRadius: '6px', fontFamily: 'monospace', fontSize: '11px', color: 'var(--accent-cyan)', border: '1px solid var(--border)' }}>
                {specCode}
              </pre>

              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => handleCopySpec(specCode)}>
                  {copiedSpec ? '✓ Copied to Clipboard!' : `Copy ${testFramework.toUpperCase()} Code`}
                </button>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => handleDownloadSpec(specCode, selectedReq.path)}>
                  📁 Download Spec File
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state">Select a request from the left pane to run Response Validation</div>
        )}
      </div>
    </div>
  );
};
