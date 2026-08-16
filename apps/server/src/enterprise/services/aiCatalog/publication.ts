import { isRecord } from '@lobechat/utils/object';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformCatalogAuthorityModel,
  PlatformRevisionConflictError,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { platformAiModels } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  isCredentialBearingUrl,
  M07_REDACTION_OPTIONS,
} from '@/server/enterprise/security/redaction';

import {
  type adminAiProviderArchiveInputSchema,
  type adminAiProviderPublishInputSchema,
  type adminAiProviderRollbackInputSchema,
  aiModelDraftSchema,
} from '../../contracts/aiCatalog';
import type { AuditAction } from '../audit/auditActionCatalog';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { invalidateAiCatalogAuthorityToken } from '../platformInstance/catalogTokens';
import { type DeferInvalidation, PlatformPublisherService } from '../platformPublisher';
import {
  resolveAiCatalogRuntimeProvider,
  validateAiCatalogCredentialShape,
} from './credentialAdapter';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependentsForModels } from './dependencies';
import {
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
import { sanitizeAiCatalogPersistedText } from './persistentText';
import { coercePublishedProviderColumns, toPublishedModelRows } from './publicationCoercion';
import type { AiCatalogSecretManager } from './secretManager';
import { aiCatalogDraftToken, appendAiCatalogFailureAudit } from './shared';

type PublishProviderInput = z.infer<typeof adminAiProviderPublishInputSchema>;
type ArchiveProviderInput = z.infer<typeof adminAiProviderArchiveInputSchema>;
type RollbackProviderInput = z.infer<typeof adminAiProviderRollbackInputSchema>;

export interface AiCatalogPublicationOptions {
  /**
   * Set when this service runs inside a caller-owned transaction: distributed invalidation
   * events and the local authority-token reset are handed over instead of fired, so nothing
   * announces a revision the enclosing transaction might still roll back.
   */
  deferInvalidation?: DeferInvalidation;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: {
    afterArchiveDependencyCheck?: () => Promise<void>;
    afterModelDependencyCheck?: () => Promise<void>;
    afterPublishLock?: (tx: Transaction) => Promise<void>;
  };
  resolveDependentsForModels?: typeof resolveAiCatalogDependentsForModels;
}

const enabledModelReferences = (payload: Record<string, unknown> | null): Set<string> => {
  if (!payload || !isRecord(payload.provider) || !Array.isArray(payload.models))
    return new Set<string>();
  const providerKey = payload.provider.providerKey;
  if (typeof providerKey !== 'string' || payload.provider.enabled !== true)
    return new Set<string>();
  return new Set(
    payload.models.flatMap((model) =>
      isRecord(model) && model.enabled === true && typeof model.modelKey === 'string'
        ? [`${providerKey}:${model.modelKey}`]
        : [],
    ),
  );
};

const assertRemovedModelsUnused = async (
  tx: Transaction,
  currentPayload: Record<string, unknown> | null,
  targetPayload: Record<string, unknown> | null,
  resolveDependentsForModels: typeof resolveAiCatalogDependentsForModels,
): Promise<boolean> => {
  const current = enabledModelReferences(currentPayload);
  const target = enabledModelReferences(targetPayload);
  const removed = [...current].filter((reference) => !target.has(reference));
  if (removed.length === 0) return false;
  const byProvider = new Map<string, string[]>();
  for (const reference of removed) {
    const separator = reference.indexOf(':');
    const providerKey = reference.slice(0, separator);
    const modelKey = reference.slice(separator + 1);
    const modelKeys = byProvider.get(providerKey);
    if (modelKeys) {
      modelKeys.push(modelKey);
    } else {
      byProvider.set(providerKey, [modelKey]);
    }
  }
  const dependents = (
    await Promise.all(
      [...byProvider].map(([providerKey, modelKeys]) =>
        resolveDependentsForModels(tx, providerKey, modelKeys),
      ),
    )
  ).flat();
  if (dependents.some((item) => item.blocking)) {
    throw new AiCatalogResourceInUseError(dependents);
  }
  return true;
};

export class AiCatalogPublicationService {
  private readonly db: LobeChatDatabase;
  private readonly deferInvalidation?: DeferInvalidation;
  private readonly lifecycle: NonNullable<AiCatalogPublicationOptions['lifecycle']>;
  private readonly publisher: PlatformPublisherService;
  private readonly resolveDependentsForModels: typeof resolveAiCatalogDependentsForModels;
  private readonly secrets: AiCatalogSecretManager;

  constructor(
    db: LobeChatDatabase,
    secrets: AiCatalogSecretManager,
    options: AiCatalogPublicationOptions = {},
  ) {
    this.db = db;
    this.deferInvalidation = options.deferInvalidation;
    this.lifecycle = options.lifecycle ?? {};
    this.publisher = new PlatformPublisherService(db, options.invalidation);
    this.resolveDependentsForModels =
      options.resolveDependentsForModels ?? resolveAiCatalogDependentsForModels;
    this.secrets = secrets;
  }

  /** Local authority-token reset — deferred with the distributed event when scoped to a tx. */
  private invalidateAuthorityToken = (): void => {
    if (this.deferInvalidation) {
      this.deferInvalidation(async () => invalidateAiCatalogAuthorityToken());
      return;
    }
    invalidateAiCatalogAuthorityToken();
  };

  private sanitizeReason = async (providerId: string, reason: string): Promise<string> => {
    const provider = await new PlatformAiCatalogRepository(this.db).getProvider(providerId);
    if (!provider?.encryptedKeyVaults) return sanitizeAiCatalogPersistedText(reason);
    try {
      const keyVaults = await this.secrets.decrypt(provider.encryptedKeyVaults);
      return sanitizeAiCatalogPersistedText(reason, [keyVaults]);
    } catch {
      return sanitizeAiCatalogPersistedText(reason);
    }
  };

  /**
   * Publish-time invariants.
   *
   * Every admin write applies immediately (draft write + unconditional publish), so this is
   * a **security / sanity** gate only — never a readiness gate. Publishing a disabled
   * provider, or one with zero models and no credentials, is legal: that is exactly how the
   * settings-page toggle persists site-wide. Chat-time errors surface at chat time.
   *
   * Kept: fetchOnClient-vs-secret, endpoint scheme without embedded credentials, secret
   * decryptability, credential shape for the resolved runtime, and no credential material in
   * public catalog fields.
   */
  private validatePublishDraft = async (
    tx: Transaction,
    providerId: string,
  ): Promise<PlatformAiProviderDraftView> => {
    const repository = new PlatformAiCatalogRepository(tx);
    const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    const issues: string[] = [];
    /**
     * Emergency disable of an already-published provider must survive a KEK/secret outage:
     * publishing `enabled: false` never reads the stored ciphertext (mirrors the same
     * carve-out in `materializePublished`).
     */
    const isDeactivatingPublished = draft.revision > 0 && draft.enabled === false;

    if (draft.secret.configured && draft.fetchOnClient) {
      issues.push('Secret-configured providers must disable fetchOnClient');
    }
    if (draft.config.endpoint) {
      try {
        const endpoint = new URL(draft.config.endpoint);
        if (
          !['http:', 'https:'].includes(endpoint.protocol) ||
          isCredentialBearingUrl(endpoint.href)
        ) {
          issues.push('Endpoint must be an HTTP(S) URL without credentials');
        }
      } catch {
        issues.push('Endpoint must be a valid URL');
      }
    }
    const provider = await repository.getProvider(providerId);
    if (!provider) throw new AiCatalogNotFoundError();
    try {
      const keyVaults =
        provider.encryptedKeyVaults && !isDeactivatingPublished
          ? await this.secrets.decrypt(provider.encryptedKeyVaults)
          : {};
      assertAiCatalogPublicFieldsExcludeCredentials(draft, keyVaults);
      if (!isDeactivatingPublished) {
        // Shape only (supported runtime + credential fields belong to it). Completeness is
        // deliberately NOT checked: a credential-less provider is publishable.
        validateAiCatalogCredentialShape(
          resolveAiCatalogRuntimeProvider(draft.providerKey, draft.settings, draft.source),
          keyVaults,
        );
      }
    } catch (error) {
      if (error instanceof AiCatalogValidationError) issues.push(...error.issues);
      else issues.push('Provider secret must be readable');
    }
    if (issues.length > 0) throw new AiCatalogValidationError(issues);
    return draft;
  };

  private createPointer = (
    providerId: string,
    actorUserId: string,
    expectedDraftToken: string,
    validateForPublish = true,
    validateArchiveDependents = false,
  ): ResourcePointerAdapter => {
    let currentPublishedPayload: Record<string, unknown> | null = null;
    return {
      assertLockedState: async (tx, { currentRevision }) => {
        await this.lifecycle.afterPublishLock?.(tx);
        await acquirePlatformDependencyPublicationLock(tx);
        const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
        if (!draft) throw new AiCatalogNotFoundError();
        if (aiCatalogDraftToken(draft) !== expectedDraftToken) {
          throw new PlatformRevisionConflictError('Provider draft token changed');
        }
        if (currentRevision > 0) {
          const current = await new PlatformAiCatalogRepository(tx).getProviderRevision(
            providerId,
            currentRevision,
          );
          currentPublishedPayload = current?.status === 'published' ? current.payload : null;
        }
        if (validateArchiveDependents) {
          await assertRemovedModelsUnused(
            tx,
            currentPublishedPayload,
            null,
            this.resolveDependentsForModels,
          );
          await this.lifecycle.afterArchiveDependencyCheck?.();
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
        if (!isRecord(payload.provider) || !Array.isArray(payload.models)) {
          throw new AiCatalogValidationError(['Revision payload is invalid']);
        }
        const provider = payload.provider;
        const models = payload.models.map((model) => aiModelDraftSchema.parse(model));
        const repository = new PlatformAiCatalogRepository(tx);
        const storedProvider = await repository.getProvider(providerId);
        if (!storedProvider) throw new AiCatalogNotFoundError();
        const secretVersion = secretFingerprint
          ? await repository.getProviderSecretVersion(providerId, secretFingerprint)
          : undefined;
        if (secretFingerprint && !secretVersion) {
          throw new AiCatalogValidationError(['Referenced provider secret version is unavailable']);
        }
        const isDeactivatingPublished =
          operation === 'publish' && provider.enabled === false && currentPublishedPayload !== null;
        const keyVaults =
          secretVersion && !isDeactivatingPublished
            ? await this.secrets.decrypt(secretVersion.ciphertext)
            : {};
        assertAiCatalogPublicFieldsExcludeCredentials(payload, keyVaults);
        if (operation === 'rollback') {
          const removed = await assertRemovedModelsUnused(
            tx,
            currentPublishedPayload,
            payload,
            this.resolveDependentsForModels,
          );
          if (removed) await this.lifecycle.afterModelDependencyCheck?.();
        }
        await repository.updateProvider(providerId, {
          ...coercePublishedProviderColumns(provider),
          encryptedKeyVaults: secretVersion?.ciphertext ?? null,
          revision,
          secretFingerprint: secretVersion?.fingerprint ?? null,
          secretKeyId: isDeactivatingPublished
            ? storedProvider.secretKeyId
            : secretVersion
              ? this.secrets.peekKeyId(secretVersion.ciphertext)
              : null,
          secretKeyVersion: isDeactivatingPublished
            ? storedProvider.secretKeyVersion
            : (secretVersion?.keyVersion ?? null),
          secretUpdatedAt: isDeactivatingPublished
            ? storedProvider.secretUpdatedAt
            : (secretVersion?.createdAt ?? null),
          status: status === 'archived' ? 'archived' : 'published',
          updatedBy: actorUserId,
        });
        await tx.delete(platformAiModels).where(eq(platformAiModels.providerId, providerId));
        if (models.length > 0) {
          const rows = toPublishedModelRows(models, {
            actorUserId,
            providerId,
            revision,
            status,
          });
          await tx.insert(platformAiModels).values(rows);
        }
        if (operation === 'publish' && status === 'published') {
          const publishedDraft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
          if (publishedDraft?.connectionTest?.status === 'success') {
            await repository.updateProvider(providerId, {
              connectionTestedDraftToken: aiCatalogDraftToken(publishedDraft),
              connectionTestedRevision: revision,
            });
          }
        }
      },
      prepareLockedPublish: async (tx) => {
        const draft = validateForPublish
          ? await this.validatePublishDraft(tx, providerId)
          : await new PlatformAiCatalogModel(tx).getProvider(providerId);
        if (!draft) throw new AiCatalogNotFoundError();
        const payload = await new PlatformAiCatalogModel(tx).prepareRevisionPayload(providerId);
        if (!payload) throw new AiCatalogNotFoundError();
        if (!validateArchiveDependents) {
          const removed = await assertRemovedModelsUnused(
            tx,
            currentPublishedPayload,
            payload as unknown as Record<string, unknown>,
            this.resolveDependentsForModels,
          );
          if (removed) await this.lifecycle.afterModelDependencyCheck?.();
        }
        return {
          afterDiff: {
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

  private withPublicationAudit = async <T>(
    action: AuditAction,
    actorUserId: string,
    id: string,
    reason: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      await appendAiCatalogFailureAudit(this.db, {
        action,
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  publishProvider = async (actorUserId: string, input: PublishProviderInput) => {
    const reason = await this.sanitizeReason(input.id, input.reason);
    return this.withPublicationAudit(
      'admin.aiProviders.publish',
      actorUserId,
      input.id,
      reason,
      async () => {
        const draft = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
        if (!draft) throw new AiCatalogNotFoundError();
        const result = await this.publisher.publish({
          actorUserId,
          deferInvalidation: this.deferInvalidation,
          expectedRevision: input.expectedRevision,
          invalidationScopes: ['ai-catalog', 'model-runtime'],
          payload: {},
          pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken),
          reason,
          redactionOptions: M07_REDACTION_OPTIONS,
          resourceId: input.id,
          resourceType: 'provider',
          secretFingerprint: draft.secret.fingerprint,
        });
        this.invalidateAuthorityToken();
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  archiveProvider = async (actorUserId: string, input: ArchiveProviderInput) => {
    const reason = await this.sanitizeReason(input.id, input.reason);
    return this.withPublicationAudit(
      'admin.aiProviders.archive',
      actorUserId,
      input.id,
      reason,
      async () => {
        const draft = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
        if (!draft) throw new AiCatalogNotFoundError();
        const result = await this.publisher.publish({
          actorUserId,
          deferInvalidation: this.deferInvalidation,
          expectedRevision: input.expectedRevision,
          invalidationScopes: ['ai-catalog', 'model-runtime'],
          payload: {},
          pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken, false, true),
          reason,
          redactionOptions: M07_REDACTION_OPTIONS,
          resourceId: input.id,
          resourceType: 'provider',
          secretFingerprint: draft.secret.fingerprint,
          status: 'archived',
        });
        this.invalidateAuthorityToken();
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  rollbackProvider = async (actorUserId: string, input: RollbackProviderInput) => {
    const reason = await this.sanitizeReason(input.id, input.reason);
    return this.withPublicationAudit(
      'admin.aiProviders.rollback',
      actorUserId,
      input.id,
      reason,
      async () => {
        const target = await new PlatformAiCatalogRepository(this.db).getProviderRevision(
          input.id,
          input.targetRevision,
        );
        if (!target || target.status !== 'published') {
          throw new AiCatalogValidationError([
            'Rollback target must be a published provider revision',
          ]);
        }
        const result = await this.publisher.rollback({
          actorUserId,
          deferInvalidation: this.deferInvalidation,
          expectedRevision: input.expectedRevision,
          invalidationScopes: ['ai-catalog', 'model-runtime'],
          pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken),
          reason,
          resourceId: input.id,
          resourceType: 'provider',
          targetRevision: input.targetRevision,
        });
        this.invalidateAuthorityToken();
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };
}
