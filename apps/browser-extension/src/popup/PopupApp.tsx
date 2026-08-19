import React, { useState, useEffect, useRef } from 'react';
import { CapturedRequest, Rule } from '@apilens/shared-types';
import { 
  KeywordFilter, 
  loadSavedKeywords, 
  saveSavedKeywords, 
  exportKeywordsToJson, 
  parseKeywordsFromJson 
} from '../shared/keywords';
import { 
  loadRules, 
  saveRules, 
  exportRulesToJson, 
  parseRulesFromJson 
} from '../shared/storage';

export const PopupApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'network' | 'keywords' | 'mocks'>('network');
  const [isRecording, setIsRecording] = useState<boolean>(true);
  const [activeTabDomain, setActiveTabDomain] = useState<string>('Loading...');
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  
  // Data
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [savedKeywords, setSavedKeywords] = useState<KeywordFilter[]>([]);
  const [mockRules, setMockRules] = useState<Rule[]>([]);
  
  // Filtering Logic (AND vs OR)
  const [keywordLogic, setKeywordLogic] = useState<'AND' | 'OR'>('AND');
  const [captureMode, setCaptureMode] = useState<'api' | 'all' | 'custom'>('api');
  const [ignoreAssets, setIgnoreAssets] = useState<boolean>(true);
  const [activeKeywordFilter, setActiveKeywordFilter] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Quick Mock Form
  const [showMockForm, setShowMockForm] = useState<boolean>(false);
  const [mockTargetUrl, setMockTargetUrl] = useState<string>('');
  const [mockStatus, setMockStatus] = useState<number>(503);
  const [mockBody, setMockBody] = useState<string>('{\n  "error": "Service Unavailable (QA Mock)",\n  "code": 503\n}');

  // Form Inputs
  const [newKeywordText, setNewKeywordText] = useState<string>('');

  // File Input Refs
  const keywordFileInputRef = useRef<HTMLInputElement>(null);
  const rulesFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Active Tab Info
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        const tab = tabs[0];
        setActiveTabId(tab.id || null);
        if (tab.url) {
          try {
            const parsed = new URL(tab.url);
            setActiveTabDomain(parsed.hostname);
          } catch (e) {
            setActiveTabDomain('Browser Tab');
          }
        }
      }
    });

    // Load persisted settings
    chrome.storage.local.get(['isRecording', 'captureMode', 'ignoreAssets', 'keywordLogic'], (res) => {
      if (res.isRecording !== undefined) setIsRecording(res.isRecording);
      if (res.captureMode) setCaptureMode(res.captureMode);
      if (res.ignoreAssets !== undefined) setIgnoreAssets(res.ignoreAssets);
      if (res.keywordLogic) setKeywordLogic(res.keywordLogic);
    });

    // Load Keywords & Rules
    loadSavedKeywords().then(k => setSavedKeywords(k));
    loadRules().then(r => setMockRules(r));

    // Initial fetch of captured requests
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTabId = tabs[0]?.id;
      chrome.runtime.sendMessage({ type: 'GET_REQUESTS', tabId: currentTabId }, (res) => {
        if (Array.isArray(res)) setRequests(res);
      });
    });

    // Listen for live requests
    const listener = (msg: any) => {
      if (msg.type === 'NEW_REQUEST') {
        if (!activeTabId || msg.tabId === activeTabId) {
          setRequests(prev => [msg.request, ...prev].slice(0, 100));
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [activeTabId]);

  const toggleRecording = () => {
    const nextState = !isRecording;
    setIsRecording(nextState);
    chrome.storage.local.set({ isRecording: nextState });
    chrome.runtime.sendMessage({ type: 'SET_RECORDING', enabled: nextState });
  };

  const toggleKeywordLogic = () => {
    const nextLogic = keywordLogic === 'AND' ? 'OR' : 'AND';
    setKeywordLogic(nextLogic);
    chrome.storage.local.set({ keywordLogic: nextLogic });
  };

  // Keywords Operations
  const handleAddKeyword = () => {
    if (!newKeywordText.trim()) return;
    const colors = ['#00E5FF', '#00E676', '#FF9100', '#D500F9', '#FFEA00'];
    const newK: KeywordFilter = {
      id: crypto.randomUUID(),
      keyword: newKeywordText.trim().toLowerCase(),
      enabled: true,
      color: colors[savedKeywords.length % colors.length],
      createdAt: Date.now()
    };
    const updated = [...savedKeywords, newK];
    setSavedKeywords(updated);
    saveSavedKeywords(updated);
    setNewKeywordText('');
  };

  const handleToggleKeyword = (id: string) => {
    const updated = savedKeywords.map(k => k.id === id ? { ...k, enabled: !k.enabled } : k);
    setSavedKeywords(updated);
    saveSavedKeywords(updated);
  };

  const handleDeleteKeyword = (id: string) => {
    const updated = savedKeywords.filter(k => k.id !== id);
    setSavedKeywords(updated);
    saveSavedKeywords(updated);
  };

  const handleImportKeywordsFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = parseKeywordsFromJson(event.target?.result as string);
        const merged = [...savedKeywords, ...imported];
        setSavedKeywords(merged);
        saveSavedKeywords(merged);
        alert(`Successfully imported ${imported.length} keyword presets!`);
      } catch (err) {
        alert('Failed to import keywords file. Check JSON format.');
      }
    };
    reader.readAsText(file);
  };

  // 1-Click Mock Request from Live Feed
  const handleQuickMockFromRequest = (req: CapturedRequest, e: React.MouseEvent) => {
    e.stopPropagation();
    setMockTargetUrl(req.path || req.url);
    setMockStatus(503);
    setMockBody(JSON.stringify({ error: `QA Injection 503 for ${req.path}`, path: req.path }, null, 2));
    setShowMockForm(true);
    setActiveTab('mocks');
  };

  // 1-Click Instant Block from Live Feed
  const handleInstantBlock = (req: CapturedRequest, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = req.path || req.url;
    const newRule: Rule = {
      id: crypto.randomUUID(),
      scenarioId: 'quick-block',
      name: `Instant Block ${target}`,
      description: `QA 503 Instant Failure Injection`,
      enabled: true,
      priority: 1,
      conditions: [{ field: 'url', operator: 'contains', value: target }],
      conditionLogic: 'and',
      action: { type: 'status-code', statusCode: 503, responseBody: '{"error":"503 Service Unavailable (Instant Block)"}' },
      applyMode: 'always',
      appliedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const updated = [...mockRules, newRule];
    setMockRules(updated);
    saveRules(updated);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated });
    alert(`⚡ Instant Block Activated! Requests containing "${target}" will fail with 503.`);
  };

  // Quick Failure Template Injections
  const handleApplyPresetTemplate = (type: '503' | '429' | 'delay' | 'empty') => {
    if (!mockTargetUrl.trim()) {
      alert('Please select or enter a target URL keyword first!');
      return;
    }
    let status = 503;
    let body = '{\n  "error": "Service Unavailable"\n}';
    let delay = 0;

    if (type === '503') {
      status = 503;
      body = '{\n  "error": "503 Service Unavailable (QA Test)"\n}';
    } else if (type === '429') {
      status = 429;
      body = '{\n  "error": "Too Many Requests (Rate Limit Exceeded)",\n  "retryAfter": 30\n}';
    } else if (type === 'delay') {
      status = 200;
      delay = 3000;
      body = '{\n  "status": "slow_response",\n  "latencyMs": 3000\n}';
    } else if (type === 'empty') {
      status = 200;
      body = '[]';
    }

    const newRule: Rule = {
      id: crypto.randomUUID(),
      scenarioId: 'template-mock',
      name: `Preset ${type} (${mockTargetUrl})`,
      description: `Preset QA injection`,
      enabled: true,
      priority: 1,
      conditions: [{ field: 'url', operator: 'contains', value: mockTargetUrl.trim() }],
      conditionLogic: 'and',
      action: { type: 'status-code', statusCode: status, responseBody: body, delayMs: delay },
      applyMode: 'always',
      appliedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const updated = [...mockRules, newRule];
    setMockRules(updated);
    saveRules(updated);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated });
    setShowMockForm(false);
    alert(`⚡ Preset ${type} applied for "${mockTargetUrl}"!`);
  };

  // Save Custom Mock Rule
  const handleSaveQuickMockRule = () => {
    if (!mockTargetUrl.trim()) {
      alert('Please enter a target URL keyword or path!');
      return;
    }
    const newRule: Rule = {
      id: crypto.randomUUID(),
      scenarioId: 'quick-mock',
      name: `Mock ${mockTargetUrl} (${mockStatus})`,
      description: `QA Failure injection for ${mockTargetUrl}`,
      enabled: true,
      priority: 1,
      conditions: [{ field: 'url', operator: 'contains', value: mockTargetUrl.trim() }],
      conditionLogic: 'and',
      action: { type: 'status-code', statusCode: mockStatus, responseBody: mockBody },
      applyMode: 'always',
      appliedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const updated = [...mockRules, newRule];
    setMockRules(updated);
    saveRules(updated);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated });
    setShowMockForm(false);
    setMockTargetUrl('');
    alert(`Mock Rule Active! Requests containing "${mockTargetUrl}" will return ${mockStatus}.`);
  };

  const handleToggleRule = (id: string) => {
    const updated = mockRules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
    setMockRules(updated);
    saveRules(updated);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated });
  };

  const handleDeleteRule = (id: string) => {
    const updated = mockRules.filter(r => r.id !== id);
    setMockRules(updated);
    saveRules(updated);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated });
  };

  const handleImportRulesFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = parseRulesFromJson(event.target?.result as string);
        const merged = [...mockRules, ...imported];
        setMockRules(merged);
        saveRules(merged);
        chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: merged });
        alert(`Successfully imported ${imported.length} QA mock rules!`);
      } catch (err) {
        alert('Failed to import rules file. Invalid JSON.');
      }
    };
    reader.readAsText(file);
  };

  const handleCopyCurl = (req: CapturedRequest, e: React.MouseEvent) => {
    e.stopPropagation();
    const curl = `curl -X ${req.method} "${req.url}"`;
    navigator.clipboard.writeText(curl);
    setCopiedId(req.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getMethodClass = (method: string) => {
    switch (method.toUpperCase()) {
      case 'GET': return 'method-get';
      case 'POST': return 'method-post';
      case 'PUT': return 'method-put';
      case 'DELETE': return 'method-delete';
      default: return 'method-other';
    }
  };

  const getStatusClass = (status?: number | null, error?: string | null) => {
    if (error || !status) return 'status-err';
    if (status >= 200 && status < 300) return 'status-2xx';
    if (status >= 300 && status < 400) return 'status-3xx';
    if (status >= 400 && status < 500) return 'status-4xx';
    return 'status-5xx';
  };

  // Unique captured URL paths for Auto-Suggest dropdown
  const capturedPaths = Array.from(new Set(requests.map(r => r.path || r.url).filter(Boolean)));

  // Filter requests by active keywords with AND vs OR logic
  const activeEnabledKeywords = savedKeywords.filter(k => k.enabled).map(k => k.keyword.toLowerCase());

  const filteredRequests = requests.filter(r => {
    if (ignoreAssets && r.type === 'static') return false;
    if (captureMode === 'api' && r.type !== 'fetch' && r.type !== 'xhr' && r.type !== 'graphql') return false;
    
    // Quick Chip filter
    if (activeKeywordFilter && !r.url.toLowerCase().includes(activeKeywordFilter.toLowerCase())) return false;

    // Enabled Saved Keywords filter with AND vs OR logic
    if (activeEnabledKeywords.length > 0) {
      if (keywordLogic === 'AND') {
        // MUST contain ALL enabled keywords
        const matchesAll = activeEnabledKeywords.every(kw => r.url.toLowerCase().includes(kw));
        if (!matchesAll) return false;
      } else {
        // Matches ANY enabled keyword
        const matchesAny = activeEnabledKeywords.some(kw => r.url.toLowerCase().includes(kw));
        if (!matchesAny) return false;
      }
    }

    return true;
  });

  const apiCount = requests.filter(r => r.type === 'fetch' || r.type === 'xhr' || r.type === 'graphql').length;
  const errorCount = requests.filter(r => (r.statusCode && r.statusCode >= 400) || r.error).length;
  const mockedCount = requests.filter(r => r.scenarioApplied).length;

  return (
    <div className="popup-container">
      {/* Hidden File Inputs for Import */}
      <input type="file" ref={keywordFileInputRef} accept=".json" style={{ display: 'none' }} onChange={handleImportKeywordsFile} />
      <input type="file" ref={rulesFileInputRef} accept=".json" style={{ display: 'none' }} onChange={handleImportRulesFile} />

      {/* Auto-suggest Datalist */}
      <datalist id="captured-paths-list">
        {capturedPaths.map((p, idx) => <option key={idx} value={p} />)}
      </datalist>

      {/* _VOIS Header */}
      <div className="popup-header">
        <div className="brand-section">
          <div className="brand-logo-icon">AL</div>
          <div className="brand-titles">
            <div className="brand-main">
              <span>ApiLens</span>
              <span className="brand-vois-tag">_VOIS</span>
            </div>
            <div className="brand-sub">IE Market Enterprise QA</div>
          </div>
        </div>

        <div 
          className={`status-pill ${isRecording ? '' : 'paused'}`}
          onClick={toggleRecording}
          title="Click to pause/resume recording"
        >
          <span className="dot-indicator"></span>
          <span>{isRecording ? 'Capturing' : 'Paused'}</span>
        </div>
      </div>

      {/* Nav Tabs */}
      <div className="popup-tabs">
        <button className={`nav-tab ${activeTab === 'network' ? 'active' : ''}`} onClick={() => setActiveTab('network')}>
          📡 Live Feed ({filteredRequests.length})
        </button>
        <button className={`nav-tab ${activeTab === 'keywords' ? 'active' : ''}`} onClick={() => setActiveTab('keywords')}>
          🏷️ Keywords ({savedKeywords.length})
        </button>
        <button className={`nav-tab ${activeTab === 'mocks' ? 'active' : ''}`} onClick={() => setActiveTab('mocks')}>
          ⚡ QA Mocks ({mockRules.length})
        </button>
      </div>

      {/* Active Target Banner */}
      <div className="domain-banner">
        <div className="domain-info">
          <span>Target:</span>
          <span className="domain-name">{activeTabDomain}</span>
        </div>
        <span className="ie-market-badge">IE Market</span>
      </div>

      {/* TAB 1: LIVE NETWORK FEED */}
      {activeTab === 'network' && (
        <>
          {/* Stats Cards */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-val red">{requests.length}</div>
              <div className="stat-lbl">Total</div>
            </div>
            <div className="stat-card">
              <div className="stat-val cyan">{apiCount}</div>
              <div className="stat-lbl">APIs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val err">{errorCount}</div>
              <div className="stat-lbl">Errors</div>
            </div>
            <div className="stat-card">
              <div className="stat-val green">{mockedCount}</div>
              <div className="stat-lbl">Mocked</div>
            </div>
          </div>

          {/* Quick Keyword Filter Chips */}
          <div className="section" style={{ paddingBottom: '0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>
                Active Keyword Filter Mode
              </span>
              <button 
                className="btn-secondary" 
                style={{ padding: '1px 6px', fontSize: '10px', color: keywordLogic === 'AND' ? 'var(--vf-red-light)' : 'var(--accent-cyan)' }}
                onClick={toggleKeywordLogic}
                title="Toggle keyword filter matching logic"
              >
                Match: <strong>{keywordLogic}</strong> (Click to change)
              </button>
            </div>

            <div className="keywords-chip-container">
              <span 
                className={`keyword-chip ${activeKeywordFilter === '' ? 'active' : ''}`}
                onClick={() => setActiveKeywordFilter('')}
              >
                All Traffic
              </span>
              {savedKeywords.map(k => (
                <span 
                  key={k.id}
                  className={`keyword-chip ${activeKeywordFilter === k.keyword ? 'active' : ''}`}
                  onClick={() => setActiveKeywordFilter(activeKeywordFilter === k.keyword ? '' : k.keyword)}
                >
                  {k.keyword}
                </span>
              ))}
            </div>
          </div>

          {/* Live Feed List */}
          <div className="section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="section-title">
              <span>Captured Network Requests</span>
              <span>{filteredRequests.length} matching</span>
            </div>

            {filteredRequests.length === 0 ? (
              <div className="empty-feed">
                <div style={{ fontSize: '20px', marginBottom: '6px' }}>📡</div>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>No API requests matching current filter.</div>
                <div style={{ fontSize: '11px', marginTop: '4px', color: 'var(--text-muted)' }}>
                  Active Keywords: {activeEnabledKeywords.length > 0 ? activeEnabledKeywords.join(` ${keywordLogic} `) : 'None'}
                </div>
              </div>
            ) : (
              <div className="feed-list">
                {filteredRequests.slice(0, 10).map((req) => (
                  <div key={req.id} className="feed-item">
                    <div className="feed-item-left">
                      <span className={`method-badge ${getMethodClass(req.method)}`}>
                        {req.method}
                      </span>
                      <span className="path-text" title={req.url}>
                        {req.scenarioApplied ? `⚡ [MOCKED] ${req.path}` : (req.path || req.url)}
                      </span>
                    </div>

                    <div className="feed-item-right">
                      <span className={`status-tag ${getStatusClass(req.statusCode, req.error)}`}>
                        {req.error ? 'ERR' : req.statusCode || '-'}
                      </span>
                      <span className="time-tag">
                        {req.durationMs ? `${req.durationMs}ms` : 'pending'}
                      </span>
                      <button 
                        className="btn-secondary" 
                        style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--accent-purple)' }}
                        onClick={(e) => handleQuickMockFromRequest(req, e)}
                        title="1-Click Custom Mock for this URL"
                      >
                        ⚡ Mock
                      </button>
                      <button 
                        className="btn-secondary" 
                        style={{ padding: '2px 6px', fontSize: '10px', color: '#FF1744' }}
                        onClick={(e) => handleInstantBlock(req, e)}
                        title="1-Click Instant 503 Block"
                      >
                        🚫 Block
                      </button>
                      <button 
                        className="btn-secondary" 
                        style={{ padding: '2px 6px', fontSize: '10px' }}
                        onClick={(e) => handleCopyCurl(req, e)}
                        title="Copy cURL command"
                      >
                        {copiedId === req.id ? '✓' : 'cURL'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* TAB 2: KEYWORD PRESETS MANAGER */}
      {activeTab === 'keywords' && (
        <div className="section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="section-title">
            <span>URL Keyword Filter Presets</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Match Mode:</span>
              <button 
                className="btn-secondary" 
                style={{ padding: '1px 6px', fontSize: '10px', color: keywordLogic === 'AND' ? 'var(--vf-red-light)' : 'var(--accent-cyan)' }}
                onClick={toggleKeywordLogic}
              >
                {keywordLogic}
              </button>
            </div>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {keywordLogic === 'AND' ? (
              <span>ℹ️ <strong>AND Logic Active:</strong> Captured URLs MUST contain <u>ALL</u> active enabled keywords!</span>
            ) : (
              <span>ℹ️ <strong>OR Logic Active:</strong> Captured URLs will match <u>ANY</u> active enabled keyword.</span>
            )}
          </div>

          <div className="filter-card" style={{ marginBottom: '12px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input 
                type="text" 
                className="input-sm" 
                placeholder="Enter URL keyword e.g. checkout or payment"
                value={newKeywordText}
                onChange={e => setNewKeywordText(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddKeyword()}
              />
              <button className="btn-primary" style={{ width: '90px' }} onClick={handleAddKeyword}>
                + Add
              </button>
            </div>
          </div>

          <div className="feed-list" style={{ flex: 1, maxHeight: '220px' }}>
            {savedKeywords.length === 0 ? (
              <div className="empty-feed">No saved URL keywords yet.</div>
            ) : (
              savedKeywords.map(k => (
                <div key={k.id} className="feed-item" style={{ cursor: 'default' }}>
                  <div className="feed-item-left">
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: k.color || '#00E5FF' }}></span>
                    <span className="path-text" style={{ fontWeight: 700 }}>{k.keyword}</span>
                  </div>
                  <div className="feed-item-right">
                    <label className="toggle" style={{ transform: 'scale(0.8)' }}>
                      <input type="checkbox" checked={k.enabled} onChange={() => handleToggleKeyword(k.id)} />
                      <span className="slider"></span>
                    </label>
                    <button className="btn-secondary" style={{ padding: '2px 6px', color: '#FF1744' }} onClick={() => handleDeleteKeyword(k.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => exportKeywordsToJson(savedKeywords)}>
              📁 Export Keywords (.json)
            </button>
            <button className="btn-secondary" style={{ flex: 1 }} onClick={() => keywordFileInputRef.current?.click()}>
              📥 Import Keywords
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: QA MOCKS & BLOCKING ENGINE */}
      {activeTab === 'mocks' && (
        <div className="section" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="section-title">
            <span>QA Failure Injection & Mock Engine</span>
            <span>{mockRules.length} rules</span>
          </div>

          {!showMockForm ? (
            <>
              <button className="btn-primary" style={{ width: '100%', marginBottom: '12px' }} onClick={() => setShowMockForm(true)}>
                + Create Failure / Mock Rule
              </button>

              <div className="feed-list" style={{ flex: 1, maxHeight: '220px' }}>
                {mockRules.length === 0 ? (
                  <div className="empty-feed">
                    No active QA mock rules. Click "+ Create Failure Rule" or click "⚡ Mock" on any request in Live Feed!
                  </div>
                ) : (
                  mockRules.map(r => (
                    <div key={r.id} className="feed-item" style={{ cursor: 'default' }}>
                      <div className="feed-item-left">
                        <span style={{ fontSize: '14px' }}>⚡</span>
                        <div>
                          <div className="path-text" style={{ fontWeight: 700 }}>{r.name}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                            Status: {r.action.statusCode || 500} | Applied: {r.appliedCount || 0} times
                          </div>
                        </div>
                      </div>
                      <div className="feed-item-right">
                        <label className="toggle" style={{ transform: 'scale(0.8)' }}>
                          <input type="checkbox" checked={r.enabled} onChange={() => handleToggleRule(r.id)} />
                          <span className="slider"></span>
                        </label>
                        <button className="btn-secondary" style={{ padding: '2px 6px', color: '#FF1744' }} onClick={() => handleDeleteRule(r.id)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                <button className="btn-secondary" style={{ flex: 1 }} onClick={() => exportRulesToJson(mockRules)}>
                  📁 Export Mocks (.json)
                </button>
                <button className="btn-secondary" style={{ flex: 1 }} onClick={() => rulesFileInputRef.current?.click()}>
                  📥 Import Mocks
                </button>
              </div>
            </>
          ) : (
            <div className="filter-card">
              {/* Quick Template Presets Bar */}
              <div style={{ marginBottom: '8px' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>
                  1-Click Presets:
                </span>
                <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                  <button className="btn-secondary" style={{ padding: '2px 6px', fontSize: '10px', color: '#FF1744' }} onClick={() => handleApplyPresetTemplate('503')}>
                    ⚡ Inject 503
                  </button>
                  <button className="btn-secondary" style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--accent-yellow)' }} onClick={() => handleApplyPresetTemplate('429')}>
                    ⚡ Inject 429 Rate Limit
                  </button>
                  <button className="btn-secondary" style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--accent-orange)' }} onClick={() => handleApplyPresetTemplate('delay')}>
                    ⚡ 3s Slow Lag
                  </button>
                  <button className="btn-secondary" style={{ padding: '2px 6px', fontSize: '10px', color: 'var(--accent-cyan)' }} onClick={() => handleApplyPresetTemplate('empty')}>
                    ⚡ Empty []
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label>Target URL Path / Keyword (Auto-Suggest Active)</label>
                <input 
                  type="text" 
                  className="input-sm" 
                  list="captured-paths-list"
                  placeholder="Select from dropdown or type keyword"
                  value={mockTargetUrl}
                  onChange={e => setMockTargetUrl(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>HTTP Response Status Code</label>
                <select className="select-sm" style={{ width: '100%' }} value={mockStatus} onChange={e => setMockStatus(Number(e.target.value))}>
                  <option value={503}>503 Service Unavailable (Failure Injection)</option>
                  <option value={500}>500 Internal Server Error</option>
                  <option value={404}>404 Not Found</option>
                  <option value={401}>401 Unauthorized</option>
                  <option value={429}>429 Too Many Requests (Rate Limit)</option>
                  <option value={200}>200 OK (Custom Mock Response)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Mock Response JSON Body</label>
                <textarea 
                  className="input-sm" 
                  value={mockBody} 
                  onChange={e => setMockBody(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-secondary" style={{ flex: 1 }} onClick={() => setShowMockForm(false)}>
                  Cancel
                </button>
                <button className="btn-primary" style={{ flex: 1 }} onClick={handleSaveQuickMockRule}>
                  Save & Enable Mock
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer Controls */}
      <div className="popup-footer">
        <button 
          className="btn-primary"
          onClick={() => {
            alert('To open full _VOIS DevTools Inspector:\nPress F12 (DevTools) → Select the "ApiLens" tab!');
          }}
        >
          <span>🔍</span> DevTools Inspector
        </button>
        <button 
          className="btn-secondary"
          onClick={() => setRequests([])}
          title="Clear request history"
        >
          Clear
        </button>
      </div>
    </div>
  );
};

export default PopupApp;
