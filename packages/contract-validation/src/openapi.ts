import type { ContractBinding, ContractSet, JsonSchema } from '@apilens/shared-types';
import { createId, safeJsonParse } from '@apilens/core';

interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string };
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
  definitions?: Record<string, JsonSchema>;
}

interface OpenApiOperation {
  operationId?: string;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiResponse {
  content?: Record<string, { schema?: JsonSchema }>;
  schema?: JsonSchema;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function hostFromServers(document: OpenApiDocument): string {
  const url = document.servers?.[0]?.url;
  if (!url) return '*';
  try {
    return new URL(url).hostname;
  } catch {
    return '*';
  }
}

export interface ContractImportResult {
  contract: ContractSet | null;
  error: string | null;
}

/**
 * Imports an OpenAPI 3 or Swagger 2 document into response-schema bindings.
 *
 * Only response schemas are extracted, because the product validates observed
 * responses; request validation is the backend's job.
 */
export function importOpenApi(json: string, now = Date.now()): ContractImportResult {
  const parsed = safeJsonParse(json);
  if (!parsed.ok) return { contract: null, error: `Document is not valid JSON: ${parsed.error}` };

  const document = parsed.value as OpenApiDocument | null;
  if (!document || typeof document !== 'object' || !document.paths) {
    return { contract: null, error: 'Document does not contain a "paths" object.' };
  }

  const definitions = { ...(document.components?.schemas ?? {}), ...(document.definitions ?? {}) };
  const hostPattern = hostFromServers(document);
  const bindings: ContractBinding[] = [];

  Object.entries(document.paths).forEach(([pathTemplate, operations]) => {
    Object.entries(operations ?? {}).forEach(([method, operation]) => {
      if (!HTTP_METHODS.includes(method.toLowerCase())) return;
      Object.entries(operation?.responses ?? {}).forEach(([status, response]) => {
        const schema =
          response?.content?.['application/json']?.schema ??
          response?.content?.['application/problem+json']?.schema ??
          response?.schema;
        if (!schema) return;

        const statusCode = /^\d{3}$/.test(status) ? Number(status) : null;
        bindings.push({
          id: createId(),
          name: operation?.operationId ?? `${method.toUpperCase()} ${pathTemplate} → ${status}`,
          method: method.toUpperCase(),
          pathTemplate,
          hostPattern,
          statusCode,
          schema,
          enabled: true,
        });
      });
    });
  });

  if (bindings.length === 0) {
    return { contract: null, error: 'No JSON response schemas were found in the document.' };
  }

  return {
    contract: {
      id: createId(),
      name: document.info?.title ?? 'Imported API',
      sourceFormat: 'openapi',
      bindings,
      definitions,
      importedAt: now,
    },
    error: null,
  };
}

/** Imports a bare JSON Schema and binds it to a single endpoint. */
export function importJsonSchema(
  json: string,
  binding: { name: string; method: string; pathTemplate: string; hostPattern: string; statusCode: number | null },
  now = Date.now(),
): ContractImportResult {
  const parsed = safeJsonParse(json);
  if (!parsed.ok) return { contract: null, error: `Schema is not valid JSON: ${parsed.error}` };
  const schema = parsed.value as JsonSchema | null;
  if (!schema || typeof schema !== 'object') return { contract: null, error: 'Schema must be a JSON object.' };

  return {
    contract: {
      id: createId(),
      name: binding.name,
      sourceFormat: 'json-schema',
      bindings: [{ id: createId(), enabled: true, schema, ...binding }],
      definitions: (schema as { definitions?: Record<string, JsonSchema> }).definitions ?? {},
      importedAt: now,
    },
    error: null,
  };
}

/**
 * Derives a schema from an observed response so a team without an OpenAPI
 * document can still detect regressions against a known-good baseline.
 */
export function inferSchema(value: unknown): JsonSchema {
  if (value === null) return { type: 'null', nullable: true };
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length > 0 ? inferSchema(value[0]) : {} };
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(record).map(([key, item]) => [key, inferSchema(item)])),
      required: Object.keys(record).filter((key) => record[key] !== undefined),
    };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: typeof value };
}
