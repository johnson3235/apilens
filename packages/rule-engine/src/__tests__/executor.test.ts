import { describe, it, expect, beforeEach } from 'vitest';
import { RuleExecutor } from '../executor';
import { RuleAction } from '@apilens/shared-types';

describe('RuleExecutor', () => {
  let executor: RuleExecutor;

  beforeEach(() => {
    executor = new RuleExecutor();
  });

  it('handles status code 500 response', () => {
    const action: RuleAction = { type: 'status-code', statusCode: 500 };
    const result = executor.executeAction(action);
    
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe(500);
    expect(result.shouldBlock).toBe(false);
  });

  it('handles custom body response', () => {
    const action: RuleAction = { 
      type: 'custom-body', 
      statusCode: 201, 
      responseBody: '{"success":true}',
      responseHeaders: { 'Content-Type': 'application/json' }
    };
    const result = executor.executeAction(action);
    
    expect(result.statusCode).toBe(201);
    expect(result.body).toBe('{"success":true}');
    expect(result.headers['Content-Type']).toBe('application/json');
  });

  it('handles delay injection', () => {
    const action: RuleAction = { type: 'slow-response', delayMs: 2000 };
    const result = executor.executeAction(action);
    
    expect(result.delayMs).toBe(2000);
  });

  it('handles connection reset error', () => {
    const action: RuleAction = { type: 'connection-reset' };
    const result = executor.executeAction(action);
    
    expect(result.shouldBlock).toBe(true);
    expect(result.errorReason).toBe('ConnectionReset');
  });

  it('generates invalid JSON', () => {
    const action: RuleAction = { type: 'invalid-json' };
    const result = executor.executeAction(action);
    
    expect(result.body).toContain('{"invalid": "json"');
    expect(() => JSON.parse(result.body)).toThrow();
  });

  it('generates truncated JSON', () => {
    const action: RuleAction = { type: 'truncated-json' };
    const result = executor.executeAction(action);
    
    expect(result.body).toContain('{"data": {"items": [1, 2, 3');
    expect(() => JSON.parse(result.body)).toThrow();
  });

  it('handles empty response', () => {
    const action: RuleAction = { type: 'empty-response' };
    const result = executor.executeAction(action);
    
    expect(result.body).toBe('');
  });

  it('handles field modification (set)', () => {
    const action: RuleAction = { 
      type: 'wrong-type', 
      modifyField: { path: 'user.name', value: 'Mocked', operation: 'set' } 
    };
    const originalBody = '{"user": {"name": "Real", "age": 30}}';
    
    const result = executor.executeAction(action, originalBody);
    const parsed = JSON.parse(result.body);
    
    expect(parsed.user.name).toBe('Mocked');
    expect(parsed.user.age).toBe(30);
  });

  it('handles field deletion', () => {
    const action: RuleAction = { 
      type: 'missing-field', 
      modifyField: { path: 'user.age', value: null, operation: 'delete' } 
    };
    const originalBody = '{"user": {"name": "Real", "age": 30}}';
    
    const result = executor.executeAction(action, originalBody);
    const parsed = JSON.parse(result.body);
    
    expect(parsed.user.name).toBe('Real');
    expect(parsed.user.age).toBeUndefined();
  });

  it('handles null field injection', () => {
    const action: RuleAction = { 
      type: 'null-field', 
      modifyField: { path: 'user.name', value: null, operation: 'nullify' } 
    };
    const originalBody = '{"user": {"name": "Real", "age": 30}}';
    
    const result = executor.executeAction(action, originalBody);
    const parsed = JSON.parse(result.body);
    
    expect(parsed.user.name).toBeNull();
  });

  it('generates common error bodies', () => {
    expect(JSON.parse(executor.generateErrorBody(404)).error.message).toBe('Not Found');
    expect(JSON.parse(executor.generateErrorBody(403)).error.message).toBe('Forbidden');
  });
});
