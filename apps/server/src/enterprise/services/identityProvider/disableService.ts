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
import { advanceIdentityProviderLkgAfterTombstone } from './lkg';
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

/**
 * Publish a signed tombstone revision and mark the provider disabled, then advance
 * local LKG best-effort so a total-DB outage cannot resurrect the provider.
 */
export const disableIdentityProvider = async (
  db: LobeChatDatabase,
  actorUserId: string,
  input: { expectedRevision: number; id: string; reason: string },
  lockedDraft: LockedDraftLoader,
): Promise<DisableIdentityProviderResult> => {
  const reason = assertReason(input.reason);
  try {
    const committed = await db.transaction(async (tx) => {
      await acquireIdentityProviderPublishedRevisionLock(tx);
      const { draft } = await lockedDraft(tx, input.id);
      if (draft.revision !== input.expectedRevision) {
        throw new PlatformRevisionConflictError('Identity provider revision changed', {
          currentRevision: draft.revision,
          expectedRevision: input.expectedRevision,
          resourceId: input.id,
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
            eq(platformResourceRevisions.resourceId, input.id),
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
          resourceId: input.id,
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
            eq(platformIdentityProviders.id, input.id),
            eq(platformIdentityProviders.revision, input.expectedRevision),
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
        targetId: input.id,
        targetType: AUDIT_TARGET_TYPE.IDENTITY_PROVIDER,
      });
      return {
        result,
        tombstoneGeneration: `${tombstoneRow.publishedAt.toISOString()}:${tombstoneRow.id}`,
      };
    });

    let lkgAdvance: DisableIdentityProviderLkgAdvance;
    try {
      const secrets = PlatformSecretService.tryFromEnv(process.env);
      if (!secrets) {
        lkgAdvance = { outcome: 'skipped', reason: 'missing_secret' };
        console.warn('[admin.identityProviders] LKG advance after disable skipped', {
          reason: 'missing_secret',
          removedProviderId: input.id,
        });
      } else {
        const advanceResult = await advanceIdentityProviderLkgAfterTombstone({
          env: process.env,
          removedProviderId: input.id,
          secrets,
          tombstoneGeneration: committed.tombstoneGeneration,
        });
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
            removedProviderId: input.id,
            result: advanceResult,
          });
        }
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
    try {
      await new PlatformAuditService(db).append({
        action: AUDIT_ACTION.IDENTITY_PROVIDERS_DISABLE_LKG_ADVANCE,
        actorUserId,
        afterDiff: {
          lkgAdvance,
          removedProviderId: input.id,
          tombstoneGeneration: committed.tombstoneGeneration,
        },
        reason,
        result:
          lkgAdvance?.outcome === 'written' || lkgAdvance?.outcome === 'unchanged'
            ? 'success'
            : 'failure',
        targetId: input.id,
        targetType: AUDIT_TARGET_TYPE.IDENTITY_PROVIDER,
      });
    } catch (auditError) {
      console.error('[admin.identityProviders] LKG advance audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        removedProviderId: input.id,
      });
    }

    return { ...committed.result, lkgAdvance };
  } catch (error) {
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
        targetId: input.id,
        targetType: AUDIT_TARGET_TYPE.IDENTITY_PROVIDER,
      });
    } catch (auditError) {
      console.error('[admin.identityProviders] disable failure audit unavailable', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};
