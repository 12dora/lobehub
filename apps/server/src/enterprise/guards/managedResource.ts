import { z } from 'zod';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { isManagedResourceFeatureEnabled } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';
import { isUnifiedSkillPath } from '@/server/services/agentDocumentVfs/mounts/skills/path';
import { normalizeAgentDocumentPath } from '@/server/services/agentDocumentVfs/path';
import type { ManagedResourceReadinessMap } from '@/types/platform/managedResources';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import {
  type ResolvedManagedResourcePolicies,
  resolvePublishedManagedResourcePolicies,
} from '../services/managedResourceCapabilities';
import {
  getManagedResourceGuardMetricSink,
  type ManagedResourceGuardMetric,
  type ManagedResourceGuardMetricSink,
} from '../services/managedResourceGuardMetrics';
import { PlatformAuditService } from '../services/platformAudit';
import { throwEnterpriseError } from './enterpriseErrors';
import {
  getManagedResourceMutationDefinition,
  type ManagedResourceMutationProcedure,
} from './managedResourceMutationRegistry';

export interface EnforceManagedResourceMutationOptions {
  auditAppend?: (params: {
    action: string;
    actorUserId: string | null;
    afterDiff: Record<string, unknown>;
    reason: null;
    result: 'denied' | 'failure' | 'success';
    targetId: string;
    targetType: string;
  }) => Promise<unknown>;
  flags?: EnterpriseFeatureFlags;
  metricSink?: ManagedResourceGuardMetricSink;
  readiness?: () => Promise<ManagedResourceReadinessMap>;
  resolvePolicies?: () => Promise<ResolvedManagedResourcePolicies>;
}

type GuardAuditOutcome = 'would_deny' | 'denied' | 'catalog_not_ready';

const appendGuardAuditBestEffort = async (params: {
  actorUserId: string | null;
  db: LobeChatDatabase;
  mode: 'observe' | 'ui-only' | 'enforced';
  options: EnforceManagedResourceMutationOptions;
  outcome: GuardAuditOutcome;
  procedure: ManagedResourceMutationProcedure;
  resource: string;
}): Promise<void> => {
  const append =
    params.options.auditAppend ??
    ((auditParams) => new PlatformAuditService(params.db).append(auditParams));
  try {
    await append({
      action: 'managedResource.legacyMutation',
      // Trusted principal id only — never request input or credentials.
      actorUserId: params.actorUserId,
      afterDiff: {
        enforcementMode: params.mode,
        outcome: params.outcome,
        procedure: params.procedure,
        resource: params.resource,
      },
      reason: null,
      // Observe-mode would_deny must not look like a successful mutation in result filters.
      result: params.outcome === 'would_deny' ? 'failure' : 'denied',
      targetId: params.procedure,
      targetType: 'managed_policy',
    });
  } catch (error) {
    // Guard observability is best-effort. Never include input or credentials.
    console.error('[managed-resource-guard] audit append failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      procedure: params.procedure,
      resource: params.resource,
    });
  }
};

const recordGuardMetricBestEffort = (
  sink: ManagedResourceGuardMetricSink,
  metric: ManagedResourceGuardMetric,
): void => {
  try {
    sink.increment(metric);
  } catch (error) {
    console.error('[managed-resource-guard] metric increment failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      procedure: metric.procedure,
      resource: metric.resource,
    });
  }
};

/**
 * Enforce a single explicitly classified legacy mutation.
 * No request input is accepted, logged, audited, or passed to metrics.
 * Principal id is used only for audit attribution, never for authorization bypass.
 */
export const enforceManagedResourceMutation = async (params: {
  db: LobeChatDatabase;
  isExemptInput?: () => boolean | Promise<boolean>;
  options?: EnforceManagedResourceMutationOptions;
  /** Audit attribution only — no ordinary-router role may bypass the guard. */
  principal?: { userId: string };
  procedure: ManagedResourceMutationProcedure;
}): Promise<void> => {
  const definition = getManagedResourceMutationDefinition(params.procedure);
  if (definition.classification === 'allow' || definition.classification === 'exempt') return;

  const options = params.options ?? {};
  const flags = options.flags ?? parseEnterpriseFeatureFlags(process.env);
  // Exact rollback compatibility: feature-off never reads policy/readiness or changes behavior.
  if (!isManagedResourceFeatureEnabled(definition.resource, flags)) return;
  const resolved = await (
    options.resolvePolicies ??
    (() =>
      resolvePublishedManagedResourcePolicies({
        db: params.db,
        flags,
        readiness: options.readiness,
      }))
  )();
  const policy = resolved.published[definition.resource];
  const mode = resolved.effectiveModes[definition.resource];
  const metricSink = options.metricSink ?? getManagedResourceGuardMetricSink();
  const actorUserId = params.principal?.userId ?? null;

  // Published enforced policies fail closed during catalog outages. Non-skill resources
  // temporarily report effective mode "unmanaged" when readiness is false (UI degrade);
  // mutations must still deny with a distinct catalog_not_ready outcome.
  if (
    policy.managed &&
    policy.enforcementMode === 'enforced' &&
    mode === 'unmanaged' &&
    isManagedResourceFeatureEnabled(definition.resource, flags) &&
    !resolved.readiness[definition.resource]
  ) {
    recordGuardMetricBestEffort(metricSink, {
      classification: definition.classification,
      mode: 'enforced',
      outcome: 'catalog_not_ready',
      procedure: params.procedure,
      resource: definition.resource,
    });
    await appendGuardAuditBestEffort({
      actorUserId,
      db: params.db,
      mode: 'enforced',
      options,
      outcome: 'catalog_not_ready',
      procedure: params.procedure,
      resource: definition.resource,
    });
    throwEnterpriseError({
      code: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
      details: { resource: definition.resource, reason: 'catalog_not_ready' },
      httpCode: 'FORBIDDEN',
      message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    });
  }

  if (mode === 'unmanaged') return;

  // Resolve input-sensitive exemptions only after feature and policy checks so
  // rollback/off mode preserves the legacy path without extra parsing or I/O.
  if (params.isExemptInput && (await params.isExemptInput())) return;

  if (mode === 'observe' || mode === 'ui-only') {
    recordGuardMetricBestEffort(metricSink, {
      classification: definition.classification,
      mode,
      outcome: 'would_deny',
      procedure: params.procedure,
      resource: definition.resource,
    });
    await appendGuardAuditBestEffort({
      actorUserId,
      db: params.db,
      mode,
      options,
      outcome: 'would_deny',
      procedure: params.procedure,
      resource: definition.resource,
    });
    return;
  }

  recordGuardMetricBestEffort(metricSink, {
    classification: definition.classification,
    mode,
    outcome: 'denied',
    procedure: params.procedure,
    resource: definition.resource,
  });
  await appendGuardAuditBestEffort({
    actorUserId,
    db: params.db,
    mode,
    options,
    outcome: 'denied',
    procedure: params.procedure,
    resource: definition.resource,
  });
  throwEnterpriseError({
    code: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    details: { resource: definition.resource },
    httpCode: 'FORBIDDEN',
    message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
  });
};

export interface ManagedResourceGuardMiddlewareOptions {
  /** Narrow exemption. Raw input and context are never logged or retained. */
  isExemptInput?: (input: unknown, ctx: unknown) => boolean | Promise<boolean>;
}

const connectorDisconnectInputSchema = z
  .object({
    id: z.string().uuid(),
    patch: z.object({ isEnabled: z.literal(false) }).strict(),
  })
  .strict();

/** Exact existing connector disconnect action; configuration patches never match. */
export const isConnectorDisconnectInput = (input: unknown): boolean =>
  connectorDisconnectInputSchema.safeParse(input).success;

const singleAgentDocumentPathSchema = z.object({ path: z.string() }).passthrough();
const pairedAgentDocumentPathSchema = z
  .object({ fromPath: z.string(), toPath: z.string() })
  .passthrough();

const isOrdinaryAgentDocumentPath = (path: string): boolean => {
  try {
    return !isUnifiedSkillPath(normalizeAgentDocumentPath(path));
  } catch {
    // Missing, invalid and traversal-ambiguous paths never receive an exemption.
    return false;
  }
};

/** A validated non-Skill VFS path. Missing or ambiguous input fails closed. */
export const isOrdinaryAgentDocumentPathInput = (input: unknown): boolean => {
  const parsed = singleAgentDocumentPathSchema.safeParse(input);
  return parsed.success && isOrdinaryAgentDocumentPath(parsed.data.path);
};

/** Both source and target must be validated non-Skill VFS paths. */
export const isOrdinaryAgentDocumentPathPairInput = (input: unknown): boolean => {
  const parsed = pairedAgentDocumentPathSchema.safeParse(input);
  return (
    parsed.success &&
    isOrdinaryAgentDocumentPath(parsed.data.fromPath) &&
    isOrdinaryAgentDocumentPath(parsed.data.toPath)
  );
};

const MANAGED_RESOURCE_GUARD_METADATA = Symbol('managedResourceGuardMetadata');

export interface ManagedResourceGuardMetadata {
  procedure: ManagedResourceMutationProcedure;
}

const attachManagedResourceGuardMetadata = (
  middleware: unknown,
  metadata: ManagedResourceGuardMetadata,
): void => {
  if (typeof middleware !== 'function') {
    throw new TypeError('Managed resource guard middleware must be a function');
  }

  Object.defineProperty(middleware, MANAGED_RESOURCE_GUARD_METADATA, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ procedure: metadata.procedure }),
    writable: false,
  });
};

/**
 * Read server-only managed-resource guard metadata from a final procedure middleware chain.
 * The Symbol property is private and non-enumerable so it cannot become API output.
 */
export const getManagedResourceGuardMetadata = (
  procedure: unknown,
): readonly ManagedResourceGuardMetadata[] => {
  if (typeof procedure !== 'function') return [];

  const middlewares = (procedure as { _def?: { middlewares?: readonly unknown[] } })._def
    ?.middlewares;
  if (!Array.isArray(middlewares)) return [];

  return middlewares.flatMap((middleware) => {
    if (typeof middleware !== 'function') return [];
    const descriptor = Object.getOwnPropertyDescriptor(middleware, MANAGED_RESOURCE_GUARD_METADATA);
    if (!descriptor) return [];
    return [descriptor.value as ManagedResourceGuardMetadata];
  });
};

export const withManagedResourceGuard = (
  procedure: ManagedResourceMutationProcedure,
  options: ManagedResourceGuardMiddlewareOptions = {},
) => {
  const { isExemptInput } = options;

  const middleware = trpc.middleware(async ({ ctx, getRawInput, next }) => {
    const db = (ctx as { serverDB?: LobeChatDatabase }).serverDB;
    if (!db) throw new Error('ManagedResourceGuard requires serverDatabase middleware');
    await enforceManagedResourceMutation({
      db,
      isExemptInput: isExemptInput
        ? async () => isExemptInput(await getRawInput(), ctx)
        : undefined,
      principal: typeof ctx.userId === 'string' ? { userId: ctx.userId } : undefined,
      procedure,
    });
    return next();
  });

  // Attach to the final function in the builder chain (same pattern as platformPermission).
  attachManagedResourceGuardMetadata(middleware._middlewares.at(-1), { procedure });
  return middleware;
};
