import { z } from 'zod';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { isManagedResourceFeatureEnabled } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';
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
    actorUserId: null;
    afterDiff: Record<string, unknown>;
    reason: null;
    result: 'denied' | 'success';
    targetId: string;
    targetType: string;
  }) => Promise<unknown>;
  flags?: EnterpriseFeatureFlags;
  metricSink?: ManagedResourceGuardMetricSink;
  readiness?: () => Promise<ManagedResourceReadinessMap>;
  resolvePolicies?: () => Promise<ResolvedManagedResourcePolicies>;
}

const appendGuardAuditBestEffort = async (params: {
  db: LobeChatDatabase;
  mode: 'observe' | 'ui-only' | 'enforced';
  options: EnforceManagedResourceMutationOptions;
  outcome: 'would_deny' | 'denied';
  procedure: ManagedResourceMutationProcedure;
  resource: string;
}): Promise<void> => {
  const append =
    params.options.auditAppend ??
    ((auditParams) => new PlatformAuditService(params.db).append(auditParams));
  try {
    await append({
      action: 'managedResource.legacyMutation',
      actorUserId: null,
      afterDiff: {
        enforcementMode: params.mode,
        outcome: params.outcome,
        procedure: params.procedure,
        resource: params.resource,
      },
      reason: null,
      result: params.outcome === 'denied' ? 'denied' : 'success',
      targetId: params.procedure,
      targetType: 'managed_policy',
    });
  } catch (error) {
    // Guard observability is best-effort. Never include input, user id, or credentials.
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
 */
export const enforceManagedResourceMutation = async (params: {
  db: LobeChatDatabase;
  options?: EnforceManagedResourceMutationOptions;
  /** Deliberately ignored for authorization: no ordinary-router role may bypass the guard. */
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
    return;
  }

  if (mode === 'unmanaged') return;

  if (mode === 'observe' || mode === 'ui-only') {
    recordGuardMetricBestEffort(metricSink, {
      classification: definition.classification,
      mode,
      outcome: 'would_deny',
      procedure: params.procedure,
      resource: definition.resource,
    });
    await appendGuardAuditBestEffort({
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
  /** Narrow input-only exemption. The raw input is never logged or retained. */
  isExemptInput?: (input: unknown) => boolean;
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

export const withManagedResourceGuard = (
  procedure: ManagedResourceMutationProcedure,
  options: ManagedResourceGuardMiddlewareOptions = {},
) =>
  trpc.middleware(async ({ ctx, getRawInput, next }) => {
    const db = (ctx as { serverDB?: LobeChatDatabase }).serverDB;
    if (!db) throw new Error('ManagedResourceGuard requires serverDatabase middleware');
    if (options.isExemptInput?.(await getRawInput())) return next();
    await enforceManagedResourceMutation({
      db,
      principal: typeof ctx.userId === 'string' ? { userId: ctx.userId } : undefined,
      procedure,
    });
    return next();
  });
