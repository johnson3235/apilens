import React, { useState } from 'react';

interface MockEditorProps {
  value: string;
  onChange: (value: string) => void;
  statusCode?: number;
}

export const MockEditor: React.FC<MockEditorProps> = ({ value, onChange, statusCode }) => {
  const [error, setError] = useState<string | null>(null);

  const validateAndChange = (val: string) => {
    try {
      if (val.trim()) {
        JSON.parse(val);
      }
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
    onChange(val);
  };

  const formatJSON = () => {
    try {
      const parsed = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, 2));
      setError(null);
    } catch (e: any) {
      setError('Cannot format invalid JSON: ' + e.message);
    }
  };

  const applyTemplate = (type: number) => {
    let template = '';
    switch(type) {
      case 400: template = '{\n  "error": "Bad Request",\n  "message": "Invalid parameters provided"\n}'; break;
      case 401: template = '{\n  "error": "Unauthorized",\n  "message": "Authentication token is missing or invalid"\n}'; break;
      case 403: template = '{\n  "error": "Forbidden",\n  "message": "You do not have permission to access this resource"\n}'; break;
      case 404: template = '{\n  "error": "Not Found",\n  "message": "The requested resource could not be found"\n}'; break;
      case 500: template = '{\n  "error": "Internal Server Error",\n  "message": "An unexpected error occurred"\n}'; break;
      case 503: template = '{\n  "error": "Service Unavailable",\n  "message": "The service is temporarily down for maintenance"\n}'; break;
    }
    validateAndChange(template);
  };

  return (
    <div className="mock-editor">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <label>Response Body (JSON)</label>
        <button className="btn btn-sm" onClick={formatJSON}>Format JSON</button>
      </div>
      <textarea 
        value={value} 
        onChange={e => validateAndChange(e.target.value)} 
        placeholder="Enter valid JSON..."
        spellCheck={false}
      />
      {error && <div className="json-error">Invalid JSON: {error}</div>}
      <div className="char-count">{value.length} characters</div>
      
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Templates</div>
        <div className="mock-editor-actions">
          <button className="template-btn" onClick={() => applyTemplate(400)}>400 Bad Request</button>
          <button className="template-btn" onClick={() => applyTemplate(401)}>401 Unauthorized</button>
          <button className="template-btn" onClick={() => applyTemplate(403)}>403 Forbidden</button>
          <button className="template-btn" onClick={() => applyTemplate(404)}>404 Not Found</button>
          <button className="template-btn" onClick={() => applyTemplate(500)}>500 Error</button>
          <button className="template-btn" onClick={() => applyTemplate(503)}>503 Unavailable</button>
          <button className="template-btn" onClick={() => validateAndChange('')}>Clear</button>
        </div>
      </div>
    </div>
  );
};
