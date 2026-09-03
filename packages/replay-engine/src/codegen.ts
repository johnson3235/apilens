import type { CodeGenOptions, CodeTarget, ReplayRequest } from '@apilens/shared-types';
import { DEFAULT_CODEGEN_OPTIONS } from '@apilens/shared-types';

function shellQuote(value: string, shell: CodeGenOptions['shell']): string {
  if (shell === 'powershell') return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function jsString(value: string): string {
  return JSON.stringify(value);
}

function prettyBody(body: string | null): string {
  if (!body) return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function toCurl(request: ReplayRequest, options: CodeGenOptions): string {
  const lineBreak = options.pretty ? (options.shell === 'powershell' ? ' `\n  ' : ' \\\n  ') : ' ';
  const parts = [`curl -X ${request.method} ${shellQuote(request.url, options.shell)}`];

  Object.entries(request.headers).forEach(([name, value]) => {
    parts.push(`-H ${shellQuote(`${name}: ${value}`, options.shell)}`);
  });

  if (request.body) parts.push(`--data-raw ${shellQuote(request.body, options.shell)}`);
  if (request.includeCredentials) parts.push('--cookie-jar cookies.txt');
  if (!request.followRedirects) parts.push('--max-redirs 0');

  return parts.join(lineBreak);
}

function toFetch(request: ReplayRequest, options: CodeGenOptions): string {
  const init: string[] = [`method: ${jsString(request.method)}`];
  if (Object.keys(request.headers).length > 0) {
    init.push(`headers: ${JSON.stringify(request.headers, null, options.pretty ? 2 : 0)}`);
  }
  if (request.body) init.push(`body: ${jsString(request.body)}`);
  if (request.includeCredentials) init.push(`credentials: "include"`);
  if (!request.followRedirects) init.push(`redirect: "manual"`);

  const separator = options.pretty ? ',\n  ' : ', ';
  return `const response = await fetch(${jsString(request.url)}, {\n  ${init.join(separator)}\n});\nconst data = await response.json();`;
}

function toAxios(request: ReplayRequest, options: CodeGenOptions): string {
  const config: string[] = [
    `method: ${jsString(request.method.toLowerCase())}`,
    `url: ${jsString(request.url)}`,
  ];
  if (Object.keys(request.headers).length > 0) {
    config.push(`headers: ${JSON.stringify(request.headers, null, options.pretty ? 2 : 0)}`);
  }
  if (request.body) config.push(`data: ${jsString(request.body)}`);
  config.push(`timeout: ${request.timeoutMs}`);
  if (request.includeCredentials) config.push('withCredentials: true');
  if (!request.followRedirects) config.push('maxRedirects: 0');

  const separator = options.pretty ? ',\n  ' : ', ';
  return `import axios from "axios";\n\nconst response = await axios({\n  ${config.join(separator)}\n});`;
}

function toPlaywright(request: ReplayRequest): string {
  const method = request.method.toLowerCase();
  const supported = ['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method);
  const options: string[] = [];
  if (Object.keys(request.headers).length > 0) options.push(`headers: ${JSON.stringify(request.headers, null, 4)}`);
  if (request.body) options.push(`data: ${jsString(request.body)}`);

  const call = supported
    ? `request.${method}(${jsString(request.url)}${options.length ? `, {\n    ${options.join(',\n    ')}\n  }` : ''})`
    : `request.fetch(${jsString(request.url)}, {\n    method: ${jsString(request.method)}${options.length ? `,\n    ${options.join(',\n    ')}` : ''}\n  })`;

  return `import { test, expect } from "@playwright/test";\n\ntest("replay ${request.method} request", async ({ request }) => {\n  const response = await ${call};\n  expect(response.status()).toBe(200);\n});`;
}

function toPythonRequests(request: ReplayRequest): string {
  const lines = ['import requests', '', `url = ${jsString(request.url)}`];
  if (Object.keys(request.headers).length > 0) lines.push(`headers = ${JSON.stringify(request.headers, null, 4)}`);
  if (request.body) lines.push(`payload = ${jsString(request.body)}`);
  const args = ['url'];
  if (Object.keys(request.headers).length > 0) args.push('headers=headers');
  if (request.body) args.push('data=payload');
  args.push(`timeout=${Math.round(request.timeoutMs / 1000)}`);
  lines.push('', `response = requests.${request.method.toLowerCase()}(${args.join(', ')})`, 'print(response.status_code, response.text)');
  return lines.join('\n');
}

function toRestAssured(request: ReplayRequest): string {
  const lines = ['given()'];
  Object.entries(request.headers).forEach(([name, value]) => {
    lines.push(`    .header(${jsString(name)}, ${jsString(value)})`);
  });
  if (request.body) lines.push(`    .body(${jsString(request.body)})`);
  lines.push('.when()', `    .${request.method.toLowerCase()}(${jsString(request.url)})`, '.then()', '    .statusCode(200);');
  return lines.join('\n');
}

/** Generates ready-to-paste code for the target of the user's choice. */
export function generateCode(request: ReplayRequest, options: Partial<CodeGenOptions> = {}): string {
  const resolved: CodeGenOptions = { ...DEFAULT_CODEGEN_OPTIONS, ...options };
  const prepared: ReplayRequest = resolved.pretty ? { ...request, body: prettyBody(request.body) } : request;

  switch (resolved.target) {
    case 'curl':
      return toCurl(prepared, resolved);
    case 'fetch':
      return toFetch(prepared, resolved);
    case 'axios':
      return toAxios(prepared, resolved);
    case 'playwright':
      return toPlaywright(prepared);
    case 'python-requests':
      return toPythonRequests(prepared);
    case 'rest-assured':
      return toRestAssured(prepared);
    default:
      return toCurl(prepared, resolved);
  }
}

export const CODE_TARGETS: Array<{ id: CodeTarget; label: string; language: string }> = [
  { id: 'curl', label: 'cURL', language: 'bash' },
  { id: 'fetch', label: 'fetch', language: 'javascript' },
  { id: 'axios', label: 'Axios', language: 'javascript' },
  { id: 'playwright', label: 'Playwright', language: 'typescript' },
  { id: 'python-requests', label: 'Python requests', language: 'python' },
  { id: 'rest-assured', label: 'REST Assured', language: 'java' },
];
