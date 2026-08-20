import { CapturedRequest } from '@apilens/shared-types';
import { extensionApi } from './browser-api';

export interface ValidationRule {
  id: string;
  name: string;
  urlKeyword: string;
  expectedStatus?: number;
  maxDurationMs?: number;
  requiredFields?: string[]; // e.g. ["id", "status", "data.user"]
  requiredHeaders?: string[]; // e.g. ["content-type", "x-correlation-id"]
  enabled: boolean;
}

export interface ValidationResult {
  requestId: string;
  ruleName: string;
  passed: boolean;
  errors: string[];
  warnings: string[];
  validatedAt: number;
}

const STORAGE_KEY = 'apilens_validation_rules';

export const DEFAULT_VALIDATION_RULES: ValidationRule[] = [
  {
    id: 'val-1',
    name: 'Standard API Success & SLA Check',
    urlKeyword: 'api',
    expectedStatus: 200,
    maxDurationMs: 1500,
    requiredHeaders: ['content-type'],
    enabled: true
  }
];

export async function loadValidationRules(): Promise<ValidationRule[]> {
  try {
    const data = await extensionApi.storage.local.get(STORAGE_KEY);
    if (data[STORAGE_KEY] && Array.isArray(data[STORAGE_KEY])) {
      return data[STORAGE_KEY];
    }
  } catch (e) {
    console.error('Error loading validation rules:', e);
  }
  return DEFAULT_VALIDATION_RULES;
}

export async function saveValidationRules(rules: ValidationRule[]): Promise<void> {
  try {
    await extensionApi.storage.local.set({ [STORAGE_KEY]: rules });
  } catch (e) {
    console.error('Error saving validation rules:', e);
  }
}

// Validate a captured response against active rules
export function validateCapturedRequest(req: CapturedRequest, rules: ValidationRule[]): ValidationResult[] {
  const results: ValidationResult[] = [];

  const active = rules.filter(r => r.enabled && r.urlKeyword && req.url.toLowerCase().includes(r.urlKeyword.toLowerCase()));

  active.forEach(rule => {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Status Code Check
    if (rule.expectedStatus && req.statusCode !== rule.expectedStatus) {
      errors.push(`Status Code mismatch: Expected ${rule.expectedStatus}, got ${req.statusCode || 'ERR'}`);
    }

    // 2. SLA Duration Check
    if (rule.maxDurationMs && req.durationMs && req.durationMs > rule.maxDurationMs) {
      warnings.push(`SLA Warning: Duration ${req.durationMs}ms exceeded threshold ${rule.maxDurationMs}ms`);
    }

    // 3. Required Headers Check
    if (rule.requiredHeaders && rule.requiredHeaders.length > 0) {
      rule.requiredHeaders.forEach(hdr => {
        const hasHdr = Object.keys(req.responseHeaders || {}).some(k => k.toLowerCase() === hdr.toLowerCase());
        if (!hasHdr) {
          errors.push(`Missing Required Header: "${hdr}"`);
        }
      });
    }

    // 4. Required JSON Fields Check
    if (rule.requiredFields && rule.requiredFields.length > 0 && req.responseBody) {
      try {
        const bodyObj = typeof req.responseBody === 'string' ? JSON.parse(req.responseBody) : req.responseBody;
        rule.requiredFields.forEach(field => {
          if (!hasNestedProperty(bodyObj, field)) {
            errors.push(`Missing Required JSON Field: "${field}"`);
          }
        });
      } catch (e) {
        errors.push(`Invalid JSON Payload: Could not parse response body`);
      }
    }

    results.push({
      requestId: req.id,
      ruleName: rule.name,
      passed: errors.length === 0,
      errors,
      warnings,
      validatedAt: Date.now()
    });
  });

  return results;
}

function hasNestedProperty(obj: any, path: string): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || !(part in current)) {
      return false;
    }
    current = current[part];
  }
  return true;
}

// Generate Automated Playwright / Cypress / Postman Assertions
export function generateAutomationTestSpec(req: CapturedRequest, framework: 'playwright' | 'cypress' | 'postman' | 'jest'): string {
  const url = req.url;
  const method = req.method;
  const status = req.statusCode || 200;

  if (framework === 'playwright') {
    return `// Playwright API Test Spec for ${req.path}
import { test, expect } from '@playwright/test';

test('${method} ${req.path} Response Validation', async ({ request }) => {
  const response = await request.${method.toLowerCase()}('${url}');
  
  // Status Code Assertion
  expect(response.status()).toBe(${status});
  
  // Headers Assertion
  expect(response.headers()['content-type']).toContain('application/json');
  
  // Body Assertion
  const body = await response.json();
  expect(body).toBeDefined();
});`;
  }

  if (framework === 'cypress') {
    return `// Cypress API Test Spec for ${req.path}
describe('${method} ${req.path}', () => {
  it('Validates response contract and status', () => {
    cy.request({
      method: '${method}',
      url: '${url}'
    }).then((response) => {
      expect(response.status).to.eq(${status});
      expect(response.headers).to.have.property('content-type');
      expect(response.body).to.exist;
    });
  });
});`;
  }

  if (framework === 'postman') {
    return `// Postman Test Scripts for ${req.path}
pm.test("Status code is ${status}", function () {
    pm.response.to.have.status(${status});
});

pm.test("Response time is less than 1500ms", function () {
    pm.expect(pm.response.responseTime).to.be.below(1500);
});

pm.test("Response body contains valid data", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData).to.be.an('object');
});`;
  }

  // Default Jest/Axios
  return `// Jest + Axios Test for ${req.path}
import axios from 'axios';

test('${method} ${req.path}', async () => {
  const res = await axios.${method.toLowerCase()}('${url}');
  expect(res.status).toBe(${status});
  expect(res.data).toBeDefined();
});`;
}
