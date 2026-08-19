import { RuleAction } from '@apilens/shared-types';

export interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
  shouldBlock: boolean;
  errorReason: string | null;
}

export class RuleExecutor {
  public executeAction(action: RuleAction, originalBody?: string): MockResponse {
    let response: MockResponse = {
      statusCode: action.statusCode || 200,
      headers: action.responseHeaders || {},
      body: action.responseBody || '',
      delayMs: action.delayMs || 0,
      shouldBlock: false,
      errorReason: action.errorReason || null,
    };

    switch (action.type) {
      case 'status-code':
        if (!action.responseBody) {
          response.body = this.generateErrorBody(response.statusCode);
        }
        break;
      case 'connection-reset':
        response.shouldBlock = true;
        response.errorReason = 'ConnectionReset';
        break;
      case 'timeout':
        response.shouldBlock = true;
        response.errorReason = 'ConnectionTimedOut';
        break;
      case 'dns-failure':
        response.shouldBlock = true;
        response.errorReason = 'NameNotResolved';
        break;
      case 'empty-response':
        response.body = '';
        break;
      case 'invalid-json':
        response.body = '{"invalid": "json", "broken": ';
        response.headers['Content-Type'] = 'application/json';
        break;
      case 'truncated-json':
        response.body = '{"data": {"items": [1, 2, 3';
        response.headers['Content-Type'] = 'application/json';
        break;
      case 'slow-response':
        response.delayMs = action.delayMs || 5000;
        break;
      case 'custom-body':
        // Values already set
        break;
      case 'missing-field':
      case 'null-field':
      case 'wrong-type':
        if (action.modifyField && originalBody) {
          response.body = this.modifyJsonField(originalBody, action.modifyField);
          response.headers['Content-Type'] = 'application/json';
        }
        break;
      case 'malformed-headers':
        response.headers = { 'X-Malformed-Header': 'invalid\nvalue' };
        break;
      case 'websocket-disconnect':
      case 'sse-interrupt':
        response.shouldBlock = true;
        break;
      case 'rate-limit':
        response.statusCode = 429;
        response.body = action.responseBody || 'Rate Limit Exceeded';
        response.headers['Retry-After'] = '60';
        break;
    }

    return response;
  }

  public generateErrorBody(statusCode: number): string {
    const errorMap: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout'
    };
    
    const message = errorMap[statusCode] || 'Error';
    
    return JSON.stringify({
      error: {
        code: statusCode,
        message: message
      }
    });
  }

  private modifyJsonField(body: string, modifier: { path: string; value: unknown; operation: 'set' | 'delete' | 'nullify' | 'changeType' }): string {
    try {
      const parsed = JSON.parse(body);
      const pathParts = modifier.path.split('.');
      let current = parsed;
      
      for (let i = 0; i < pathParts.length - 1; i++) {
        if (current[pathParts[i]] === undefined) {
          current[pathParts[i]] = {};
        }
        current = current[pathParts[i]];
      }
      
      const lastPart = pathParts[pathParts.length - 1];
      
      switch (modifier.operation) {
        case 'set':
          current[lastPart] = modifier.value;
          break;
        case 'delete':
          delete current[lastPart];
          break;
        case 'nullify':
          current[lastPart] = null;
          break;
        case 'changeType':
          if (typeof current[lastPart] === 'string') {
            current[lastPart] = 123;
          } else if (typeof current[lastPart] === 'number') {
            current[lastPart] = String(current[lastPart]);
          } else if (typeof current[lastPart] === 'boolean') {
            current[lastPart] = "true";
          } else {
             current[lastPart] = "changed";
          }
          break;
      }
      
      return JSON.stringify(parsed);
    } catch (e) {
      return body; // return original if invalid JSON
    }
  }
}
