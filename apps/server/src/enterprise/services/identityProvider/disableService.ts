import { and, desc, eq } from 'drizzle-orm';

import {
  acquireIdentityProviderPublishedRevisionLock,
  checksumPayload,
  type PlatformIdentityProviderInternalDraft,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { platformIdentityProviders, platformResourceRevisions } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformSecretService } from '../../security/secret';
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import {
  advanceIdentityProviderLkgAfterTombstone,
  clearIdentityProviderRevocation,
  finalizeIdentityProviderRevocation,
  recordIdentityProviderRevocation,
} from './lkg';
import { assertReason } from './publicationIdempotency';
import {
  IdentityProviderPublicationError,
  parsePublishedIdentityProviderPayload,
} from './publishedPayload';

export type DisableIdentityProviderLkgAdvance =
  | { outcome: 'written' | 'unchanged' | 'skipped' | 'rejected' | 'error'; reason?: string }
  | undefined;

export type DisableIdentityProviderResult = PlatformIdentityProviderInternalDraft & {
  /** Outcome of the best-effort post-disable LKG advance (audited; never fails disable). */
  lkgAdvance?: DisableIdentityProviderLkgAdvance;
};

type LockedDraftLoader = (
  tx: Transaction,
  id: string,
) => Promise<{ draft: PlatformIdentityProviderInternalDraft; secretRef: string | null }>;

const publishIdentityProviderTombstone = async (
  tx: Transaction,
  {
    actorUserId,
    expectedRevision,
    id,
    reason,
  }: { actorUserId: string; expectedRevision: number; id: string; reason: string },
  lockedDraft: LockedDraftLoader,
) => {
  await acquireIdentityProviderPublishedRevisionLock(tx);
  const { draft } = await lockedDraft(tx, id);
  if (draft.revision !== expectedRevision) {
    throw new PlatformRevisionConflictError('Identity provider revision changed', {
      currentRevision: draft.revision,
      expectedRevision,
      resourceId: id,
      resourceType: 'oidc',
    });
  }
  if (draft.status === 'disabled' || draft.status === 'archived') {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }

  const [latestPublished] = await tx
    .select({
      payload: platformResourceRevisions.payload,
      secretFingerprint: platformResourceRevisions.secretFingerprint,
    })
    .from(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, 'oidc'),
        eq(platformResourceRevisions.resourceId, id),
        eq(platformResourceRevisions.status, 'published'),
      ),
    )
    .orderBy(desc(platformResourceRevisions.revision))
    .limit(1);
  const basePayload = latestPublished
    ? parsePublishedIdentityProviderPayload(latestPublished.payload)
    : null;
  if (!basePayload) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }

  const tombstonePayload = {
    ...basePayload,
    enabled: false,
    secretFingerprint: basePayload.secretFingerprint,
    ...(basePayload.secretUpdatedAt ? { secretUpdatedAt: basePayload.secretUpdatedAt } : {}),
  };
  const parsed = parsePublishedIdentityProviderPayload(tombstonePayload);
  if (!parsed || parsed.enabled !== false) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }

  const nextRevision = draft.revision + 1;
  const now = new Date();
  const checksum = checksumPayload(parsed);
  const [tombstoneRow] = await tx
    .insert(platformResourceRevisions)
    .values({
      checksum,
      comment: reason,
      createdBy: actorUserId,
      payload: parsed as unknown as Record<string, unknown>,
      publishedAt: now,
      publishedBy: actorUserId,
      resourceId: id,
      resourceType: 'oidc',
      revision: nextRevision,
      secretFingerprint: parsed.secretFingerprint,
      status: 'published',
    })
    .returning({
      id: platformResourceRevisions.id,
      publishedAt: platformResourceRevisions.publishedAt,
    });
  if (!tombstoneRow?.id || !tombstoneRow.publishedAt) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  const [updated] = await tx
    .update(platformIdentityProviders)
    .set({
      activationRevision: nextRevision,
      enabled: false,
      revision: nextRevision,
      status: 'pending_restart',
      updatedAt: now,
      updatedBy: actorUserId,
    })
    .where(
      and(
        eq(platformIdentityProviders.id, id),
        eq(platformIdentityProviders.revision, expectedRevision),
        eq(platformIdentityProviders.status, draft.status),
      ),
    )
    .returning();
  if (!updated) throw new PlatformRevisionConflictError();

  const result: PlatformIdentityProviderInternalDraft = {
    ...draft,
    activationRevision: nextRevision,
    enabled: false,
    revision: nextRevision,
    status: 'pending_restart',
  };
  await new PlatformAuditService(tx).append({
    action: AUDIT_ACTION.IDENTITY_PROVIDERS_DISABLE,
    actorUserId,
    afterDiff: {
      activation: 'pending_restart',
      checksum,
      enabled: false,
      providerKey: parsed.providerKey,
      revision: nextRevision,
      tombstone: true,
    },
    beforeDiff: { revision: draft.revision, status: draft.status },
    configRevision: nextRevision,
    reason,
    result: 'success',
    targetId: id,
    targetType: AUDIT_TARGET_TYPE.IDENTITY_PROVIDER,
  });
  return {
    result,
    tombstoneGeneration: `${tombstoneRow.publishedAt.toISOString()}:${tombstoneRow.id}`,
  };
};

const classifyLkgAdvance = (
  advanceResult: Awaited<ReturnType<typeof advanceIdentityProviderLkgAfterTombstone>>,
  removedProviderId: string,
): { lkgAdvance: DisableIdentityProviderLkgAdvance; safeToClearJournal: boolean } => {
  let lkgAdvance: DisableIdentityProviderLkgAdvance;
  if (
    advanceResult === 'written' ||
    advanceResult === 'unchanged' ||
    advanceResult === 'rejected'
  ) {
    lkgAdvance = { outcome: advanceResult };
  } else if (typeof advanceResult === 'object' && advanceResult.outcome === 'skipped') {
    lkgAdvance = { outcome: 'skipped', reason: advanceResult.reason };
  } else {
    lkgAdvance = { outcome: 'skipped', reason: 'unknown' };
  }
  if (
    advanceResult === 'rejected' ||
    (typeof advanceResult === 'object' && advanceResult.outcome === 'skipped')
  ) {
    console.warn('[admin.identityProviders] LKG advance after disable not applied', {
      reason: typeof advanceResult === 'object' ? advanceResult.reason : 'rejected',
      removedProviderId,
      result: advanceResult,
    });
  }
  const safeToClearJournal =
    advanceResult === 'written' ||
    advanceResult === 'unchanged' ||
    advanceResult === 'rejected' ||
    (typeof advanceResult === 'object' &&
      advanceResult.outcome === 'skipped' &&
      advanceResult.reason === 'stale_tombstone');
  return { lkgAdvance, safeToClearJournal };
};

const appendDisableLkgAdvanceAudit = async (
  db: LobeChatDatabase,
  {
    actorUserId,
    id,
    lkgAdvance,
    reason,
    tombstoneGeneration,
  }: {
    actorUserId: string;
    id: string;
    lkgAdvance: DisableIdentityProviderLkgAdvance;
    reason: string;
    tombstoneGeneration: string;
  },
) => {
  try {
    await new PlatformAuditService(db).append({
      action: AUDIT_ACTION.IDENTITY_PROVIDERS_DISABLE_LKG_ADVANCE,
      actorUserId,
      afterDiff: {
        lkgAdvance,
        removedProviderId: id,
        tombstoneGeneration,
      },
      reason,
      result:
        lkgAdvance?.outcome === 'written' || lkgAdvance?.outcome === 'unchanged'
          ? 'success'
          : 'failure',
      targetId: id,
      targetType: AUDIT_TARGET_TYPE.IDENTITY_PROVIDER,
    });
  } catch (auditError) {
    console.error('[admin.identityProviders] LKG advance audit unavailable', {
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      removedProviderId: id,
    });
  }
};

const appendDisableFailureAudit = async (
  db: LobeChatDatabase,
  {
    actorUserId,
    error,
    id,
    reason,
  }: { actorUserId: string; error: unknown; id: string; reason: string },
) => {
  try {
    await new PlatformAuditService(db).append({
      action: AUDIT_ACTION.IDENTITY_PROVIDERS_DISABLE,
      actorUserId,
      afterDiff: {
        category:
          error instanceof PlatformRevisionConflictError
            ? 'revision_conflict'
            : 'identity_provider_disable_failed',
      },
      reason,
      result: 'failure',
      targetId: id,
      targetType: AUDIT_TARGET_TYPE.IDENTITY_PROVIDER,
    });
  } catch (auditError) {
    console.error('[admin.identityProviders] disable failure audit unavailable', {
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

/**
 * Persist an out-of-database fail-closed denial, publish the signed tombstone,
 * then advance the main LKG. An ordinary success is never returned unless an
 * outage-time startup can enforce the denial independently of the database.
 */
export const disableIdentityProvider = async (
  db: LobeChatDatabase,
  actorUserId: string,
  input: { expectedRevision: number; id: string; reason: string },
  lockedDraft: LockedDraftLoader,
): Promise<DisableIdentityProviderResult> => {
  const reason = assertReason(input.reason);
  const secrets = PlatformSecretService.tryFromEnv(process.env);
  if (!secrets) {
    throw new Error('PLATFORM_IDENTITY_PROVIDER_REVOCATION_JOURNAL_SECRET_UNAVAILABLE');
  }
  let revocationToken: string | null = null;
  let tombstoneCommitted = false;
  try {
    revocationToken = await recordIdentityProviderRevocation({
      env: process.env,
      providerId: input.id,
      secrets,
    });
    const committed = await db.transaction(async (tx) =>
      publishIdentityProviderTombstone(
        tx,
        { actorUserId, expectedRevision: input.expectedRevision, id: input.id, reason },
        lockedDraft,
      ),
    );
    tombstoneCommitted = true;

    try {
      await finalizeIdentityProviderRevocation({
        env: process.env,
        generation: committed.tombstoneGeneration,
        secrets,
        token: revocationToken,
      });
    } catch (journalError) {
      // The pending entry is stricter than the finalized form and remains
      // fail-closed. Keep going so a healthy main-LKG advance can recover it.
      console.error('[admin.identityProviders] revocation journal finalize unavailable', {
        errorClass: journalError instanceof Error ? journalError.name : 'UnknownError',
        removedProviderId: input.id,
      });
    }

    let lkgAdvance: DisableIdentityProviderLkgAdvance;
    try {
      const advanceResult = await advanceIdentityProviderLkgAfterTombstone({
        env: process.env,
        removedProviderId: input.id,
        secrets,
        tombstoneGeneration: committed.tombstoneGeneration,
      });
      const classified = classifyLkgAdvance(advanceResult, input.id);
      lkgAdvance = classified.lkgAdvance;
      if (classified.safeToClearJournal) {
        await clearIdentityProviderRevocation({
          env: process.env,
          secrets,
          token: revocationToken,
        });
      }
    } catch (lkgError) {
      lkgAdvance = {
        outcome: 'error',
        reason: lkgError instanceof Error ? lkgError.name : 'UnknownError',
      };
      console.error('[admin.identityProviders] LKG advance after disable unavailable', {
        errorClass: lkgError instanceof Error ? lkgError.name : 'UnknownError',
        removedProviderId: input.id,
      });
    }

    // Surface LKG outcome on the audit trail so operators can detect silent LKG lag.
    await appendDisableLkgAdvanceAudit(db, {
      actorUserId,
      id: input.id,
      lkgAdvance,
      reason,
      tombstoneGeneration: committed.tombstoneGeneration,
    });

    return { ...committed.result, lkgAdvance };
  } catch (error) {
    if (revocationToken && !tombstoneCommitted) {
      try {
        await clearIdentityProviderRevocation({
          env: process.env,
          secrets,
          token: revocationToken,
        });
      } catch (cleanupError) {
        console.error('[admin.identityProviders] revocation journal cleanup unavailable', {
          errorClass: cleanupError instanceof Error ? cleanupError.name : 'UnknownError',
          removedProviderId: input.id,
        });
      }
    }
    await appendDisableFailureAudit(db, { actorUserId, error, id: input.id, reason });
    throw error;
  }
};
