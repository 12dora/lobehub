import { isRecord } from '@lobechat/utils/object';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformRevisionConflictError,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type NewPlatformAiModel,
  type PlatformAiModelAbilities,
  type PlatformAiModelConfig,
  type PlatformAiModelParameters,
  type PlatformAiModelPricing,
  platformAiModels,
  type PlatformAiModelSettings,
  type PlatformAiProviderConfig,
  type PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { M07_REDACTION_OPTIONS } from '@/server/enterprise/security/redaction';

import {
  type adminAiProviderArchiveInputSchema,
  type adminAiProviderPublishInputSchema,
  type adminAiProviderRollbackInputSchema,
  aiModelDraftSchema,
} from '../../contracts/aiCatalog';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { PlatformPublisherService } from '../platformPublisher';
import { resolveAiCatalogDependents } from './dependencies';
import {
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
import type { AiCatalogSecretManager } from './secretManager';
import { aiCatalogDraftToken, appendAiCatalogFailureAudit } from './shared';

type PublishProviderInput = z.infer<typeof adminAiProviderPublishInputSchema>;
type ArchiveProviderInput = z.infer<typeof adminAiProviderArchiveInputSchema>;
type RollbackProviderInput = z.infer<typeof adminAiProviderRollbackInputSchema>;

export interface AiCatalogPublicationOptions {
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: { afterPublishLock?: () => Promise<void> };
}

export class AiCatalogPublicationService {
  private readonly db: LobeChatDatabase;
  private readonly lifecycle: NonNullable<AiCatalogPublicationOptions['lifecycle']>;
  private readonly publisher: PlatformPublisherService;
  private readonly secrets: AiCatalogSecretManager;

  constructor(
    db: LobeChatDatabase,
    secrets: AiCatalogSecretManager,
    options: AiCatalogPublicationOptions = {},
  ) {
    this.db = db;
    this.lifecycle = options.lifecycle ?? {};
    this.publisher = new PlatformPublisherService(db, options.invalidation);
    this.secrets = secrets;
  }

  private validatePublishDraft = async (
    tx: Transaction,
    providerId: string,
  ): Promise<PlatformAiProviderDraftView> => {
    const repository = new PlatformAiCatalogRepository(tx);
    const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    const issues: string[] = [];
    if (!draft.enabled) issues.push('Provider must be enabled');
    const enabledModels = draft.models.filter((model) => model.enabled);
    if (enabledModels.length === 0) issues.push('At least one model must be enabled');
    if (draft.secret.configured && draft.fetchOnClient) {
      issues.push('Secret-configured providers must disable fetchOnClient');
    }
    if (draft.connectionTest?.status !== 'success' || draft.connectionTest.stale) {
      issues.push('Current provider draft must pass connection testing before publish');
    }
    if (draft.checkModel && !enabledModels.some((model) => model.modelKey === draft.checkModel)) {
      issues.push('Check model must reference an enabled model');
    }
    if (draft.config.endpoint) {
      try {
        const endpoint = new URL(draft.config.endpoint);
        if (
          !['http:', 'https:'].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password
        ) {
          issues.push('Endpoint must be an HTTP(S) URL without credentials');
        }
      } catch {
        issues.push('Endpoint must be a valid URL');
      }
    }
    const provider = await repository.getProvider(providerId);
    if (!provider) throw new AiCatalogNotFoundError();
    const secretOptional = draft.settings.sdkType === 'ollama';
    if (!provider.encryptedKeyVaults && !secretOptional) {
      issues.push('Provider secret must be configured');
    } else if (provider.encryptedKeyVaults) {
      try {
        await this.secrets.decrypt(provider.encryptedKeyVaults);
      } catch {
        issues.push('Provider secret must be readable');
      }
    }
    if (issues.length > 0) throw new AiCatalogValidationError(issues);
    return draft;
  };

  private createPointer = (
    providerId: string,
    actorUserId: string,
    expectedDraftToken: string,
    validateForPublish = true,
  ): ResourcePointerAdapter => ({
    assertLockedState: async (tx) => {
      await this.lifecycle.afterPublishLock?.();
      const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
      if (!draft) throw new AiCatalogNotFoundError();
      if (aiCatalogDraftToken(draft) !== expectedDraftToken) {
        throw new PlatformRevisionConflictError('Provider draft token changed');
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
      const secretVersion = secretFingerprint
        ? await repository.getProviderSecretVersion(providerId, secretFingerprint)
        : undefined;
      if (secretFingerprint && !secretVersion) {
        throw new AiCatalogValidationError(['Referenced provider secret version is unavailable']);
      }
      await repository.updateProvider(providerId, {
        checkModel: typeof provider.checkModel === 'string' ? provider.checkModel : null,
        config: isRecord(provider.config) ? (provider.config as PlatformAiProviderConfig) : {},
        description: typeof provider.description === 'string' ? provider.description : null,
        displayName:
          typeof provider.displayName === 'string' ? provider.displayName : 'Unnamed provider',
        enabled: provider.enabled === true,
        encryptedKeyVaults: secretVersion?.ciphertext ?? null,
        fetchOnClient: provider.fetchOnClient === true,
        logo: typeof provider.logo === 'string' ? provider.logo : null,
        revision,
        secretFingerprint: secretVersion?.fingerprint ?? null,
        secretKeyVersion: secretVersion?.keyVersion ?? null,
        secretUpdatedAt: secretVersion?.createdAt ?? null,
        settings: isRecord(provider.settings)
          ? (provider.settings as PlatformAiProviderSettings)
          : {},
        sort: typeof provider.sort === 'number' ? provider.sort : 0,
        source: typeof provider.source === 'string' ? provider.source : 'custom',
        status: status === 'archived' ? 'archived' : 'published',
        updatedBy: actorUserId,
      });
      await tx.delete(platformAiModels).where(eq(platformAiModels.providerId, providerId));
      if (models.length > 0) {
        const rows: NewPlatformAiModel[] = models.map((model) => ({
          ...model,
          abilities: model.abilities as PlatformAiModelAbilities,
          config: model.config as PlatformAiModelConfig | null,
          parameters: model.parameters as PlatformAiModelParameters,
          pricing: model.pricing as PlatformAiModelPricing | null,
          providerId,
          publishedAt: status === 'published' ? new Date() : null,
          revision,
          settings: model.settings as PlatformAiModelSettings,
          status: status === 'archived' ? 'archived' : 'published',
          updatedBy: actorUserId,
        }));
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
    },
  });

  publishProvider = async (actorUserId: string, input: PublishProviderInput) => {
    try {
      const draft = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
      if (!draft) throw new AiCatalogNotFoundError();
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['ai-catalog', 'model-runtime'],
        payload: {},
        pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken),
        reason: input.reason,
        redactionOptions: M07_REDACTION_OPTIONS,
        resourceId: input.id,
        resourceType: 'provider',
        secretFingerprint: draft.secret.fingerprint,
      });
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      await appendAiCatalogFailureAudit(this.db, {
        action: 'admin.aiProviders.publish',
        actorUserId,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };

  archiveProvider = async (actorUserId: string, input: ArchiveProviderInput) => {
    const draft = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
    if (!draft) throw new AiCatalogNotFoundError();
    const dependents = (
      await Promise.all(
        draft.models.map((model) =>
          resolveAiCatalogDependents(this.db, draft.providerKey, model.modelKey),
        ),
      )
    ).flat();
    if (dependents.some((item) => item.blocking)) {
      throw new AiCatalogResourceInUseError(dependents);
    }
    try {
      const result = await this.publisher.publish({
        actorUserId,
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['ai-catalog', 'model-runtime'],
        payload: {},
        pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken, false),
        reason: input.reason,
        redactionOptions: M07_REDACTION_OPTIONS,
        resourceId: input.id,
        resourceType: 'provider',
        secretFingerprint: draft.secret.fingerprint,
        status: 'archived',
      });
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      await appendAiCatalogFailureAudit(this.db, {
        action: 'admin.aiProviders.archive',
        actorUserId,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };

  rollbackProvider = async (actorUserId: string, input: RollbackProviderInput) => {
    try {
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
        expectedRevision: input.expectedRevision,
        invalidationScopes: ['ai-catalog', 'model-runtime'],
        pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken),
        reason: input.reason,
        resourceId: input.id,
        resourceType: 'provider',
        targetRevision: input.targetRevision,
      });
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      await appendAiCatalogFailureAudit(this.db, {
        action: 'admin.aiProviders.rollback',
        actorUserId,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };
}
