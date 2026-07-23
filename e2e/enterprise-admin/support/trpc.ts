import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';

/**
 * tRPC lambda HTTP helpers (batch=1 query shape used by the product client).
 * Cookie jar is owned by the Playwright request/context — never logged.
 *
 * Safe projection validation mirrors apps/server adminSystemGetStatusOutputSchema
 * (hierarchical .strict()), with SuperJSON wire dates accepted as ISO string | Date.
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

/** Wire date: SuperJSON may leave ISO strings on HTTP JSON without client rehydrate. */
const wireDate = z.union([
  z.date(),
  z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'invalid date string'),
]);

const dependencyHealth = z
  .object({
    errorCategory: z
      .enum(['configuration_incomplete', 'operation_unavailable', 'passive_check_only', 'timeout'])
      .nullable(),
    status: z.enum(['degraded', 'disabled', 'healthy', 'unavailable', 'unknown']),
  })
  .strict();

const revisionToken = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), value: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('immutable_id'), value: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);

/** Mirrors platformDomainConvergenceSchema (apps/server contracts) — hierarchical .strict(). */
const domainConvergence = z
  .object({
    counts: z
      .object({
        degraded: z.number().int().nonnegative(),
        diverged: z.number().int().nonnegative(),
        fresh: z.number().int().nonnegative(),
        matching: z.number().int().nonnegative(),
        stale: z.number().int().nonnegative(),
        unreported: z.number().int().nonnegative(),
      })
      .strict(),
    domain: z.enum([
      'agent_catalog',
      'ai_catalog',
      'branding',
      'connector_catalog',
      'identity',
      'managed_policy',
      'settings',
      'skill_catalog',
    ]),
    errorCategory: z
      .enum([
        'cache_unavailable',
        'configuration_invalid',
        'database_unavailable',
        'instance_status_unavailable',
        'lkg_invalid',
        'lkg_unavailable',
        'load_failed',
        'secret_unavailable',
        'startup_unavailable',
      ])
      .nullable(),
    fallbackPolicy: z.enum(['none', 'builtin', 'lkg_then_break_glass']),
    loadMode: z.enum(['process_cached', 'request_scoped', 'restart_activated']),
    status: z.enum([
      'disabled',
      'not_applicable',
      'converged',
      'diverged',
      'degraded',
      'unreported',
      'unavailable',
    ]),
    targetToken: revisionToken.nullable(),
  })
  .strict();

/**
 * Hierarchical DTO equivalent of adminSystemGetStatusOutputSchema (.strict() at every object).
 * Derived from apps/server/src/enterprise/contracts/adminSystem.ts — rejects wrong-path keys
 * and nested credential/token/url fields that the flat allowlist used to accept.
 */
export const adminSystemStatusWireSchema = z
  .object({
    build: z
      .object({
        gitSha: z
          .string()
          .regex(/^[a-f0-9]{7,40}$/)
          .nullable(),
        version: z.string().trim().min(1).max(64),
      })
      .strict(),
    dependencies: z
      .object({
        database: dependencyHealth,
        keyManagement: dependencyHealth,
        mail: dependencyHealth,
        objectStorage: dependencyHealth,
        redis: dependencyHealth,
      })
      .strict(),
    domains: z.array(domainConvergence).max(8),
    featureFlags: z
      .object({
        databaseOidc: z.boolean(),
        managedAgents: z.boolean(),
        managedAi: z.boolean(),
        managedConnectors: z.boolean(),
        managedSkills: z.boolean(),
        platformAdmin: z.boolean(),
        runtimeBranding: z.boolean(),
        settingsPolicy: z.boolean(),
      })
      .strict(),
    instanceStatus: dependencyHealth,
    jobs: z
      .object({
        active: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        errorCategory: z.enum(['operation_unavailable']).nullable(),
        failed: z.number().int().nonnegative(),
        status: z.enum(['healthy', 'unavailable']),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    oidc: z
      .object({
        activeRevision: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        configured: z.boolean(),
        pendingRestart: z.boolean(),
        source: z.enum(['break_glass', 'database', 'disabled', 'environment', 'lkg', 'unknown']),
        status: z.enum(['degraded', 'disabled', 'healthy', 'unavailable', 'unknown']),
      })
      .strict(),
    recentPublishFailures: z
      .object({
        count: z.number().int().nonnegative(),
        errorCategory: z.enum(['operation_unavailable']).nullable(),
        items: z
          .array(
            z
              .object({
                category: z.enum([
                  'conflict',
                  'dependency_unavailable',
                  'operation_unavailable',
                  'unknown',
                  'validation',
                ]),
                domain: z.enum([
                  'agent_catalog',
                  'ai_catalog',
                  'branding',
                  'connector_catalog',
                  'identity',
                  'managed_policy',
                  'settings',
                  'skill_catalog',
                ]),
                occurredAt: wireDate,
              })
              .strict(),
          )
          .max(10),
        status: z.enum(['healthy', 'unavailable']),
      })
      .strict(),
    snapshotAt: wireDate,
  })
  .strict();

export const assertSafeProjection = (value: unknown): void => {
  const parsed = adminSystemStatusWireSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `admin.system.getStatus failed strict DTO validation: ${parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
};

/** @deprecated flat allowlist removed — use assertSafeProjection hierarchical DTO */
export const ADMIN_SYSTEM_STATUS_ALLOWED_KEYS = new Set<string>();

export interface TrpcErrorParts {
  enterpriseCode?: string;
  message?: string;
  trpcCode?: string;
}

/**
 * Parse tRPC batch error envelope including SuperJSON-shaped cause data (errorData).
 */
export const extractTrpcErrorParts = (json: unknown): TrpcErrorParts => {
  if (!Array.isArray(json) || json.length === 0) return {};
  const first = json[0] as {
    error?: {
      json?: {
        code?: number | string;
        data?: {
          code?: string;
          errorData?: { code?: string; message?: string };
          httpStatus?: number;
          message?: string;
        };
        message?: string;
      };
    };
  };
  const err = first.error?.json;
  if (!err) return {};
  const trpcCode =
    typeof err.data?.code === 'string'
      ? err.data.code
      : typeof err.code === 'string'
        ? err.code
        : undefined;
  const enterpriseCode =
    (typeof err.data?.errorData?.code === 'string' && err.data.errorData.code) ||
    (typeof err.data?.errorData?.message === 'string' && err.data.errorData.message) ||
    undefined;
  const message = typeof err.message === 'string' ? err.message : undefined;
  return { enterpriseCode, message, trpcCode };
};

export const extractTrpcErrorMessage = (json: unknown): string | undefined => {
  const parts = extractTrpcErrorParts(json);
  return parts.message ?? parts.enterpriseCode;
};

export const extractTrpcHttpErrorCode = (json: unknown): string | undefined =>
  extractTrpcErrorParts(json).trpcCode;

/**
 * Exact permission denial:
 * HTTP 403 + tRPC code FORBIDDEN + enterprise code/message PLATFORM_PERMISSION_DENIED.
 * Does NOT accept bare FORBIDDEN or unrelated enterprise codes.
 */
export const assertExactPermissionDenied = (result: TrpcResult): void => {
  if (result.status !== 403) {
    throw new Error(`expected HTTP 403, got ${result.status}: ${result.text.slice(0, 300)}`);
  }
  const parts = extractTrpcErrorParts(result.json);
  if (parts.trpcCode !== 'FORBIDDEN') {
    throw new Error(
      `expected tRPC code FORBIDDEN, got ${parts.trpcCode ?? '<missing>'}: ${result.text.slice(0, 300)}`,
    );
  }
  const enterprise = parts.enterpriseCode ?? parts.message;
  if (enterprise !== 'PLATFORM_PERMISSION_DENIED') {
    throw new Error(
      `expected enterprise code PLATFORM_PERMISSION_DENIED exactly, got ${enterprise ?? '<missing>'}: ${result.text.slice(0, 300)}`,
    );
  }
};

/**
 * @deprecated EasyAuth access gate removed — ordinary principals now get
 * PLATFORM_PERMISSION_DENIED on admin routes. Prefer assertExactPermissionDenied.
 */
export const assertExactAccessNotGranted = assertExactPermissionDenied;

/**
 * Managed-resource denial: HTTP 403 + FORBIDDEN + RESOURCE_MANAGED_BY_PLATFORM exactly.
 */
export const assertExactManagedResourceDenied = (result: TrpcResult): void => {
  if (result.status !== 403) {
    throw new Error(`expected HTTP 403, got ${result.status}: ${result.text.slice(0, 300)}`);
  }
  const parts = extractTrpcErrorParts(result.json);
  if (parts.trpcCode !== 'FORBIDDEN') {
    throw new Error(
      `expected tRPC code FORBIDDEN, got ${parts.trpcCode ?? '<missing>'}: ${result.text.slice(0, 300)}`,
    );
  }
  const enterprise = parts.enterpriseCode ?? parts.message;
  if (enterprise !== 'RESOURCE_MANAGED_BY_PLATFORM') {
    // Some envelopes put the code only in message with extra text — require exact match.
    throw new Error(
      `expected enterprise code RESOURCE_MANAGED_BY_PLATFORM exactly, got ${enterprise ?? '<missing>'}: ${result.text.slice(0, 400)}`,
    );
  }
};
