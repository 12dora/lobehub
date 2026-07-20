import type { APIRequestContext } from '@playwright/test';

/**
 * tRPC lambda HTTP helpers (batch=1 query shape used by the product client).
 * Cookie jar is owned by the Playwright request/context — never logged.
 */
const emptyInput = encodeURIComponent(JSON.stringify({ 0: { json: null } }));

const parseJsonBody = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export interface TrpcResult {
  json: unknown;
  ok: boolean;
  status: number;
  text: string;
}

export const trpcQuery = async (
  request: APIRequestContext,
  path: string,
  input: unknown = null,
): Promise<TrpcResult> => {
  const encoded =
    input === null ? emptyInput : encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  const response = await request.get(`/trpc/lambda/${path}?batch=1&input=${encoded}`, {
    timeout: 120_000,
  });
  const text = await response.text();
  return { json: parseJsonBody(text), ok: response.ok(), status: response.status(), text };
};

export const trpcMutation = async (
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<TrpcResult> => {
  const response = await request.post(`/trpc/lambda/${path}?batch=1`, {
    data: { 0: { json: input } },
    headers: {
      'content-type': 'application/json',
    },
    timeout: 120_000,
  });
  const text = await response.text();
  return { json: parseJsonBody(text), ok: response.ok(), status: response.status(), text };
};

/**
 * Extract the first batch procedure result data from a tRPC HTTP batch payload.
 * Fails hard when the envelope is missing — never returns soft null for required fields.
 */
export const extractBatchData = (json: unknown): unknown => {
  if (!Array.isArray(json) || json.length === 0) {
    throw new Error('tRPC batch response is not a non-empty array');
  }
  const first = json[0] as { error?: unknown; result?: { data?: { json?: unknown } | unknown } };
  if (first.error) {
    throw new Error(`tRPC batch entry is an error: ${JSON.stringify(first.error).slice(0, 400)}`);
  }
  const data = first.result?.data;
  if (data && typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
};

export const extractTrpcErrorMessage = (json: unknown): string | undefined => {
  if (!Array.isArray(json) || json.length === 0) return undefined;
  const first = json[0] as {
    error?: { json?: { message?: string; data?: { code?: string; message?: string } } };
  };
  const err = first.error?.json;
  if (!err) return undefined;
  if (typeof err.message === 'string') return err.message;
  if (typeof err.data?.message === 'string') return err.data.message;
  if (typeof err.data?.code === 'string') return err.data.code;
  return undefined;
};

export const extractTrpcHttpErrorCode = (json: unknown): string | undefined => {
  if (!Array.isArray(json) || json.length === 0) return undefined;
  const first = json[0] as {
    error?: { json?: { data?: { code?: string }; code?: number } };
  };
  const dataCode = first.error?.json?.data?.code;
  if (typeof dataCode === 'string') return dataCode;
  return undefined;
};

/** Exact denial: HTTP 403 and enterprise/permission code (not arbitrary uppercase codes). */
export const assertExactPermissionDenied = (result: TrpcResult): void => {
  if (result.status !== 403) {
    throw new Error(`expected HTTP 403, got ${result.status}: ${result.text.slice(0, 300)}`);
  }
  const message = extractTrpcErrorMessage(result.json) ?? result.text;
  const httpCode = extractTrpcHttpErrorCode(result.json);
  const ok =
    message.includes('PLATFORM_PERMISSION_DENIED') ||
    message.includes('FORBIDDEN') ||
    httpCode === 'FORBIDDEN';
  if (!ok) {
    throw new Error(
      `expected PLATFORM_PERMISSION_DENIED/FORBIDDEN, got message=${message} code=${httpCode}`,
    );
  }
};

export const assertExactManagedResourceDenied = (result: TrpcResult): void => {
  if (result.status !== 403) {
    throw new Error(`expected HTTP 403, got ${result.status}: ${result.text.slice(0, 300)}`);
  }
  const message = extractTrpcErrorMessage(result.json) ?? result.text;
  if (
    !message.includes('RESOURCE_MANAGED_BY_PLATFORM') &&
    !result.text.includes('RESOURCE_MANAGED_BY_PLATFORM')
  ) {
    throw new Error(`expected RESOURCE_MANAGED_BY_PLATFORM, got: ${result.text.slice(0, 400)}`);
  }
};

/**
 * Recursively allowlist object keys and value types for safe status projections.
 * Unknown keys or secret-like string patterns fail.
 */
export const assertSafeProjection = (
  value: unknown,
  options: {
    allowedKeys: ReadonlySet<string>;
    path?: string;
  },
): void => {
  const path = options.path ?? '$';
  const forbiddenSubstrings = [
    'postgres:postgres',
    'secret-',
    'VAULT_TOKEN',
    'Bearer ',
    'sk-',
    'password=',
    'ACCESS_KEY',
    'PRIVATE_KEY',
  ];

  if (value === null || value === undefined) return;
  if (typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    for (const bad of forbiddenSubstrings) {
      if (value.includes(bad)) {
        throw new Error(`safe projection leak at ${path}: forbidden substring`);
      }
    }
    return;
  }
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafeProjection(item, { allowedKeys: options.allowedKeys, path: `${path}[${index}]` }),
    );
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!options.allowedKeys.has(key)) {
        throw new Error(`safe projection unknown key at ${path}.${key}`);
      }
      assertSafeProjection(child, {
        allowedKeys: options.allowedKeys,
        path: `${path}.${key}`,
      });
    }
    return;
  }
  throw new Error(`safe projection invalid type at ${path}: ${typeof value}`);
};

/** Keys permitted in admin.system.getStatus safe projection (contract-aligned, recursive). */
export const ADMIN_SYSTEM_STATUS_ALLOWED_KEYS = new Set([
  'build',
  'gitSha',
  'version',
  'dependencies',
  'database',
  'keyManagement',
  'mail',
  'objectStorage',
  'redis',
  'errorCategory',
  'status',
  'domains',
  'domain',
  'featureFlags',
  'databaseOidc',
  'managedAgents',
  'managedAi',
  'managedConnectors',
  'managedSkills',
  'platformAdmin',
  'runtimeBranding',
  'settingsPolicy',
  'instanceStatus',
  'jobs',
  'active',
  'completed',
  'failed',
  'total',
  'oidc',
  'activeRevision',
  'configured',
  'pendingRestart',
  'source',
  'recentPublishFailures',
  'count',
  'counts',
  'items',
  'category',
  'occurredAt',
  'snapshotAt',
  'loadedAt',
  'loadedToken',
  'loadMode',
  'lastErrorCategory',
  'revision',
  'token',
  'health',
  'convergence',
  'publishedRevision',
  'runtimeRevision',
  'lag',
  'instances',
  'healthy',
  'degraded',
  'unavailable',
  'unknown',
  'draft',
  'archived',
  'published',
  'targetRevisionId',
  'loadedRevisionId',
  'generation',
  'message',
  'detail',
  'reason',
  'mode',
  'observedAt',
  'updatedAt',
  'createdAt',
  'startedAt',
  'finishedAt',
  'name',
  'id',
  'kind',
  'type',
  'value',
  'label',
  'ok',
  'ready',
  'enabled',
  'disabled',
  'pending',
  'running',
  'success',
  'failure',
  'error',
  'warning',
  'info',
  'degraded',
  'diverged',
  'fresh',
  'matching',
  'stale',
  'unreported',
  'fallbackPolicy',
  'targetToken',
  'available',
  'unavailable',
  'unknown',
  'break_glass',
  'environment',
  'lkg',
]);
