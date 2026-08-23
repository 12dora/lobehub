import { eq } from 'drizzle-orm';

import type {
  PlatformAiProviderDraftView,
  ResourcePointerAdapter,
} from '@/database/models/platform';
import {
  PlatformAiCatalogModel,
  PlatformCatalogAuthorityModel,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { platformAiModels } from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import type { resolveAiCatalogDependentsForModels } from './dependencies';
import { AiCatalogNotFoundError } from './errors';
import {
  EMPTY_FORCE_DISABLE_LOCKS,
  type ForceDisabledDependents,
  type ForceDisableLockSet,
  lockForceDisableTargets,
} from './forceDisableDependents';
import {
  assertRemovedModelsUnused,
  enabledModelReferences,
  resolveBlockingDependents,
} from './publication.dependents';
import { materializePublishedProvider } from './publication.materialize';
import type { AiCatalogSecretManager } from './secretManager';
import { aiCatalogDraftToken } from './shared';

type PublicationPointerLifecycle = {
  afterArchiveDependencyCheck?: () => Promise<void>;
  afterModelDependencyCheck?: () => Promise<void>;
  afterPublishLock?: (tx: Transaction) => Promise<void>;
};

export interface AiCatalogPublicationPointerParams {
  actorUserId: string;
  expectedDraftToken: string;
  force?: boolean;
  lifecycle: PublicationPointerLifecycle;
  providerId: string;
  resolveDependentsForModels: typeof resolveAiCatalogDependentsForModels;
  secrets: AiCatalogSecretManager;
  validateArchiveDependents?: boolean;
  validateForPublish?: boolean;
  validatePublishDraft: (
    tx: Transaction,
    providerId: string,
  ) => Promise<PlatformAiProviderDraftView>;
}

export const createAiCatalogPublicationPointer = (
  params: AiCatalogPublicationPointerParams,
): ResourcePointerAdapter => {
  const force = params.force === true;
  const validateArchiveDependents = params.validateArchiveDependents === true;
  const validateForPublish = params.validateForPublish !== false;
  let currentPublishedPayload: Record<string, unknown> | null = null;
  let forceDisabledDependents: ForceDisabledDependents | undefined;
  let forceLocks: ForceDisableLockSet = EMPTY_FORCE_DISABLE_LOCKS;
  const { actorUserId, lifecycle, providerId, resolveDependentsForModels, secrets } = params;

  return {
    assertLockedState: async (tx, { currentRevision }) => {
      await lifecycle.afterPublishLock?.(tx);
      const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
      if (!draft) throw new AiCatalogNotFoundError();
      if (aiCatalogDraftToken(draft) !== params.expectedDraftToken) {
        throw new PlatformRevisionConflictError('Provider draft token changed');
      }
      if (currentRevision > 0) {
        const current = await new PlatformAiCatalogRepository(tx).getProviderRevision(
          providerId,
          currentRevision,
        );
        currentPublishedPayload = current?.status === 'published' ? current.payload : null;
      }
      if (force) {
        // Preview the currently enabled set (a superset of any models this publish
        // will drop) and lock those foreign rows before the advisory lock.
        const preview = await resolveBlockingDependents(
          tx,
          enabledModelReferences(currentPublishedPayload),
          resolveDependentsForModels,
        );
        forceLocks = await lockForceDisableTargets(tx, preview);
      }
      await acquirePlatformDependencyPublicationLock(tx);
      if (validateArchiveDependents) {
        const check = await assertRemovedModelsUnused(
          tx,
          currentPublishedPayload,
          null,
          resolveDependentsForModels,
          { actorUserId, force, locks: forceLocks },
        );
        forceDisabledDependents = check.forceDisabledDependents;
        await lifecycle.afterArchiveDependencyCheck?.();
      }
    },
    lockAndGetRevision: async (tx) => {
      const provider = await new PlatformAiCatalogRepository(tx).lockProvider(providerId);
      if (!provider) throw new AiCatalogNotFoundError();
      return provider.revision;
    },
    materializePublished: async (
      tx,
      { operation, payload, revision, secretFingerprint, status },
    ) => {
      await materializePublishedProvider(tx, {
        actorUserId,
        afterCredentialCheck: async () => {
          if (operation !== 'rollback') return;
          // Rollback writes a fixed afterDiff (`restoredFromRevision`); forceDisabledDependents
          // from this check is not copied onto that audit row.
          const check = await assertRemovedModelsUnused(
            tx,
            currentPublishedPayload,
            payload,
            resolveDependentsForModels,
            { actorUserId, force, locks: forceLocks },
          );
          forceDisabledDependents = check.forceDisabledDependents ?? forceDisabledDependents;
          if (check.removed) await lifecycle.afterModelDependencyCheck?.();
        },
        currentPublishedPayload,
        operation,
        payload,
        providerId,
        revision,
        secretFingerprint,
        secrets,
        status,
      });
    },
    prepareLockedPublish: async (tx) => {
      const draft = validateForPublish
        ? await params.validatePublishDraft(tx, providerId)
        : await new PlatformAiCatalogModel(tx).getProvider(providerId);
      if (!draft) throw new AiCatalogNotFoundError();
      const payload = await new PlatformAiCatalogModel(tx).prepareRevisionPayload(providerId);
      if (!payload) throw new AiCatalogNotFoundError();
      if (!validateArchiveDependents) {
        const check = await assertRemovedModelsUnused(
          tx,
          currentPublishedPayload,
          payload as unknown as Record<string, unknown>,
          resolveDependentsForModels,
          { actorUserId, force, locks: forceLocks },
        );
        forceDisabledDependents = check.forceDisabledDependents ?? forceDisabledDependents;
        if (check.removed) await lifecycle.afterModelDependencyCheck?.();
      }
      return {
        afterDiff: {
          ...(forceDisabledDependents ? { forceDisabledDependents } : {}),
          modelCount: draft.models.length,
          providerId,
          secretFingerprint: draft.secret.fingerprint,
        },
        payload: payload as unknown as Record<string, unknown>,
      };
    },
    updatePointer: async (tx, { revision, status }) => {
      const repository = new PlatformAiCatalogRepository(tx);
      await repository.updateProvider(providerId, {
        revision,
        status: status === 'archived' ? 'archived' : 'published',
        updatedBy: actorUserId,
      });
      await tx
        .update(platformAiModels)
        .set({
          publishedAt: status === 'published' ? new Date() : null,
          revision,
          status: status === 'archived' ? 'archived' : 'published',
          updatedAt: new Date(),
          updatedBy: actorUserId,
        })
        .where(eq(platformAiModels.providerId, providerId));
      // Advance multi-instance catalog authority in the same transaction as the pointer.
      await new PlatformCatalogAuthorityModel(tx).bumpGeneration('ai_catalog');
    },
  };
};
