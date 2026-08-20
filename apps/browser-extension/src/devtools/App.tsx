import React, { useState, useEffect, useRef } from 'react';
import { CapturedRequest, Rule } from '@apilens/shared-types';
import { RequestList } from './components/RequestList';
import { RequestDetail } from './components/RequestDetail';
import { ScenarioBuilder } from './components/ScenarioBuilder';
import { Timeline } from './components/Timeline';
import { ResponseValidator } from './components/ResponseValidator';
import { 
  KeywordFilter, 
  loadSavedKeywords, 
  saveSavedKeywords 
} from '../shared/keywords';
import { 
  loadRules, 
  saveRules, 
  parseRulesFromJson 
} from '../shared/storage';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'requests' | 'scenarios' | 'timeline' | 'validator'>('requests');
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [savedKeywords, setSavedKeywords] = useState<KeywordFilter[]>([]);
  const [selectedRequest, setSelectedRequest] = useState<CapturedRequest | null>(null);
  const [inspectedTabId, setInspectedTabId] = useState<number | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [methodFilter, setMethodFilter] = useState<string>('ALL');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [mockFilter, setMockFilter] = useState<'ALL' | 'MOCKED' | 'REAL' | 'SERVER'>('ALL');
  const [ignoreAssets, setIgnoreAssets] = useState<boolean>(true);
  const [activeChipKeyword, setActiveChipKeyword] = useState<string>('');

  // File Inputs
  const rulesFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Inspected tab ID
    const tabId = chrome.devtools?.inspectedWindow?.tabId || null;
    setInspectedTabId(tabId);

    // Initial fetch of captured requests
    chrome.runtime.sendMessage({ type: 'GET_REQUESTS', tabId }, (res) => {
      if (Array.isArray(res)) setRequests(res);
    });

    // Load saved rules & keywords
    loadRules().then(r => setRules(r));
    loadSavedKeywords().then(k => setSavedKeywords(k));

    // Listen for live incoming requests
    const listener = (msg: any) => {
      if (msg.type === 'NEW_REQUEST') {
        if (!tabId || msg.tabId === tabId) {
          setRequests(prev => [...prev, msg.request].slice(-1000));
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const handleClear = () => {
    setRequests([]);
    setSelectedRequest(null);
    chrome.runtime.sendMessage({ type: 'CLEAR_REQUESTS', tabId: inspectedTabId });
  };

  const handleCreateRuleFromRequest = (req: CapturedRequest) => {
    const newRule: Rule = {
      id: crypto.randomUUID(),
      scenarioId: 'quick-mock',
      name: `Mock ${req.method} ${req.path}`,
      description: `Generated from request ${req.url}`,
      enabled: true,
      priority: 1,
      conditions: [
        { field: 'url', operator: 'contains', value: req.path },
        { field: 'method', operator: 'equals', value: req.method }
      ],
      conditionLogic: 'and',
      action: { 
        type: 'status-code', 
        statusCode: 503, 
        responseBody: '{\n  "error": "QA Mock 503 Service Unavailable"\n}' 
      },
      applyMode: 'always',
      appliedCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const updated = [...rules, newRule];
    setRules(updated);
    saveRules(updated);
    chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated, tabId: chrome.devtools.inspectedWindow.tabId });
    setActiveTab('scenarios');
  };

  const handleImportRulesFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = parseRulesFromJson(event.target?.result as string);
        const merged = [...rules, ...imported];
        setRules(merged);
        saveRules(merged);
        chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: merged, tabId: chrome.devtools.inspectedWindow.tabId });
        alert(`Successfully imported ${imported.length} QA mock rules!`);
      } catch (err) {
        alert('Failed to import rules. Check JSON structure.');
      }
    };
    reader.readAsText(file);
  };

  const handleExportNetworkLogJson = () => {
    const dataStr = JSON.stringify(requests, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `apilens-network-traffic-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Filter requests
  const filteredRequests = requests.filter(req => {
    // Asset filter
    if (ignoreAssets && req.type === 'static') return false;

    // Search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchUrl = req.url.toLowerCase().includes(q);
      const matchPath = req.path.toLowerCase().includes(q);
      const matchMethod = req.method.toLowerCase().includes(q);
      if (!matchUrl && !matchPath && !matchMethod) return false;
    }

    // Keyword Chip filter
    if (activeChipKeyword && !req.url.toLowerCase().includes(activeChipKeyword.toLowerCase())) {
      return false;
    }

    // Method filter
    if (methodFilter !== 'ALL' && req.method.toUpperCase() !== methodFilter) return false;

    // Type filter
    if (typeFilter !== 'ALL') {
      if (typeFilter === 'API' && req.type !== 'fetch' && req.type !== 'xhr' && req.type !== 'graphql') return false;
      if (typeFilter === 'STATIC' && req.type !== 'static') return false;
      if (typeFilter === 'NAV' && req.type !== 'navigation') return false;
    }

    // Status filter
    if (statusFilter !== 'ALL') {
      const s = req.statusCode || 0;
      if (statusFilter === '2XX' && (s < 200 || s >= 300)) return false;
      if (statusFilter === '3XX' && (s < 300 || s >= 400)) return false;
      if (statusFilter === '4XX' && (s < 400 || s >= 500)) return false;
      if (statusFilter === '5XX' && s < 500) return false;
      if (statusFilter === 'ERR' && !req.error && (s < 400 || !s)) return false;
    }

    if (mockFilter === 'MOCKED' && !req.scenarioApplied) return false;
    if (mockFilter === 'REAL' && req.scenarioApplied) return false;
    if (mockFilter === 'SERVER' && req.isClientSide) return false;

    return true;
  });

  return (
    <div className="apilens-app">
      {/* Hidden File Import Inputs */}
      <input type="file" ref={rulesFileInputRef} accept=".json" style={{ display: 'none' }} onChange={handleImportRulesFile} />

      {/* Header */}
      <div className="apilens-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="apilens-logo">ApiLens</div>
          <span style={{ fontSize: '10px', background: 'var(--vf-red)', color: '#fff', padding: '1px 5px', borderRadius: '3px', fontWeight: 800 }}>
            _VOIS IE Market
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
            Tab #{inspectedTabId || 'Active'}
          </span>
        </div>

        <div className="apilens-tabs">
          <button className={`tab-btn ${activeTab === 'requests' ? 'active' : ''}`} onClick={() => setActiveTab('requests')}>
            🌐 Network ({filteredRequests.length})
          </button>
          <button className={`tab-btn ${activeTab === 'validator' ? 'active' : ''}`} onClick={() => setActiveTab('validator')}>
            🧪 QA Validator
          </button>
          <button className={`tab-btn ${activeTab === 'timeline' ? 'active' : ''}`} onClick={() => setActiveTab('timeline')}>
            📊 Timeline
          </button>
          <button className={`tab-btn ${activeTab === 'scenarios' ? 'active' : ''}`} onClick={() => setActiveTab('scenarios')}>
            ⚡ Scenarios ({rules.length})
          </button>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button className="btn btn-sm" onClick={handleExportNetworkLogJson} title="Export network log to JSON">
            📁 Export Log
          </button>
          <button className="btn btn-sm" onClick={() => rulesFileInputRef.current?.click()} title="Import mock rules from JSON">
            📥 Import Rules
          </button>
          <button className="btn btn-sm" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="apilens-content">
        {activeTab === 'requests' && (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            {/* Filter Bar */}
            <div className="filter-bar" style={{ flexWrap: 'wrap', gap: '8px', padding: '8px 12px', background: 'var(--bg-panel)' }}>
              <input 
                type="text"
                className="input-sm"
                placeholder="Search URL, path, method..." 
                value={searchQuery} 
                onChange={e => setSearchQuery(e.target.value)} 
                style={{ width: '220px' }} 
              />

              <div style={{ display: 'flex', gap: '4px' }}>
                {['ALL', 'GET', 'POST', 'PUT', 'DELETE'].map(m => (
                  <button 
                    key={m} 
                    className={`btn btn-sm ${methodFilter === m ? 'btn-primary' : ''}`}
                    onClick={() => setMethodFilter(m)}
                    style={{ fontSize: '10px', padding: '2px 8px' }}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <select 
                className="input-sm" 
                value={typeFilter} 
                onChange={e => setTypeFilter(e.target.value)}
                style={{ width: '120px' }}
              >
                <option value="ALL">All Types</option>
                <option value="API">Fetch / XHR Only</option>
                <option value="NAV">Navigation</option>
                <option value="STATIC">Static Assets</option>
              </select>

              <select
                className="input-sm"
                value={mockFilter}
                onChange={e => setMockFilter(e.target.value as typeof mockFilter)}
                style={{ width: '150px' }}
              >
                <option value="ALL">All Traffic</option>
                <option value="MOCKED">⚡ Mocked by ApiLens</option>
                <option value="REAL">Real Responses</option>
                <option value="SERVER">Server-side Only</option>
              </select>

              <select 
                className="input-sm" 
                value={statusFilter} 
                onChange={e => setStatusFilter(e.target.value)}
                style={{ width: '110px' }}
              >
                <option value="ALL">All Statuses</option>
                <option value="2XX">2xx Success</option>
                <option value="3XX">3xx Redirect</option>
                <option value="4XX">4xx Client Err</option>
                <option value="5XX">5xx Server Err</option>
                <option value="ERR">Errors Only</option>
              </select>

              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto' }}>
                <input 
                  type="checkbox" 
                  checked={ignoreAssets} 
                  onChange={e => setIgnoreAssets(e.target.checked)} 
                />
                Hide Static Assets
              </label>
            </div>

            {/* Keyword Chips Bar */}
            {savedKeywords.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', padding: '6px 12px', background: 'var(--bg-dark)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>Saved Keywords:</span>
                <span 
                  className={`tag ${activeChipKeyword === '' ? 'active' : ''}`} 
                  onClick={() => setActiveChipKeyword('')}
                  style={{ cursor: 'pointer', background: activeChipKeyword === '' ? 'var(--vf-red)' : '', color: activeChipKeyword === '' ? '#fff' : '' }}
                >
                  All
                </span>
                {savedKeywords.map(k => (
                  <span 
                    key={k.id}
                    className="tag"
                    onClick={() => setActiveChipKeyword(activeChipKeyword === k.keyword ? '' : k.keyword)}
                    style={{ 
                      cursor: 'pointer', 
                      background: activeChipKeyword === k.keyword ? 'var(--vf-red)' : 'var(--bg-panel)',
                      color: activeChipKeyword === k.keyword ? '#fff' : k.color || '#00E5FF',
                      border: `1px solid ${activeChipKeyword === k.keyword ? 'var(--vf-red)' : 'var(--border)'}`
                    }}
                  >
                    {k.keyword}
                  </span>
                ))}
              </div>
            )}

            {/* Request List & Detail Container */}
            <div className="request-list-container">
              <RequestList 
                requests={filteredRequests} 
                requestCount={filteredRequests.length} 
                clearRequests={handleClear}
                onCreateRule={handleCreateRuleFromRequest}
                onSelectRequest={setSelectedRequest}
                selectedRequestId={selectedRequest?.id || null}
              />
              {selectedRequest && (
                <RequestDetail 
                  request={selectedRequest} 
                  onClose={() => setSelectedRequest(null)}
                  onCreateRule={handleCreateRuleFromRequest}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === 'validator' && (
          <ResponseValidator requests={filteredRequests} />
        )}

        {activeTab === 'timeline' && (
          <Timeline requests={filteredRequests} traces={[]} />
        )}

        {activeTab === 'scenarios' && (
          <ScenarioBuilder 
            rules={rules}
            onAddRule={r => {
              const updated = [...rules.filter(rule => rule.id !== r.id), r];
              setRules(updated);
              saveRules(updated);
              chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated, tabId: chrome.devtools.inspectedWindow.tabId });
            }}
            onRemoveRule={id => {
              const updated = rules.filter(r => r.id !== id);
              setRules(updated);
              saveRules(updated);
              chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated, tabId: chrome.devtools.inspectedWindow.tabId });
            }}
            onToggleRule={id => {
              const updated = rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r);
              setRules(updated);
              saveRules(updated);
              chrome.runtime.sendMessage({ type: 'SYNC_RULES', rules: updated, tabId: chrome.devtools.inspectedWindow.tabId });
            }}
          />
        )}
      </div>
    </div>
  );
};

export default App;
