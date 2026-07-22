import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type PlatformAiModelAbilities,
  type PlatformAiModelConfig,
  type PlatformAiModelItem,
  type PlatformAiModelParameters,
  type PlatformAiModelPricing,
  type PlatformAiModelSettings,
  type PlatformAiProviderConfig,
  type PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type adminAiModelCreateInputSchema,
  type adminAiModelDeleteInputSchema,
  type adminAiModelReorderInputSchema,
  type adminAiModelUpdateInputSchema,
  type adminAiProviderCreateDraftInputSchema,
  type adminAiProviderDeleteInputSchema,
  type adminAiProviderUpdateDraftInputSchema,
  aiModelDraftSchema,
  type AiProviderDraft,
  aiProviderDraftSchema,
} from '../../contracts/aiCatalog';
import type { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { AiCatalogReadService } from './catalogReadService';
import {
  AiCatalogConnectionTestService,
  type AiConnectionProbe,
  type AiConnectionTestResult,
} from './connectionTestService';
import {
  normalizeAiCatalogExecutionCredentials,
  validateAiCatalogCredentialShape,
  validateAiCatalogRuntimeProvider,
} from './credentialAdapter';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependents } from './dependencies';
import {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
import { sanitizeAiCatalogPersistedText } from './persistentText';
import { AiCatalogPublicationService } from './publication';
import { AiCatalogSecretManager, type AiSecretMutation } from './secretManager';
import {
  aiCatalogDraftToken,
  appendAiCatalogFailureAudit,
  getLockedAiCatalogDraft,
} from './shared';

type CreateProviderInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
type UpdateProviderInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;
type CreateModelInput = z.infer<typeof adminAiModelCreateInputSchema>;
type UpdateModelInput = z.infer<typeof adminAiModelUpdateInputSchema>;
type DeleteModelInput = z.infer<typeof adminAiModelDeleteInputSchema>;
type DeleteProviderInput = z.infer<typeof adminAiProviderDeleteInputSchema>;
type ReorderModelsInput = z.infer<typeof adminAiModelReorderInputSchema>;

export interface AiCatalogAdminServiceOptions {
  connectionProbe?: AiConnectionProbe;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: {
    afterDraftLock?: () => Promise<void>;
    afterArchiveDependencyCheck?: () => Promise<void>;
    afterModelDependencyCheck?: () => Promise<void>;
    afterPublishLock?: (tx: Transaction) => Promise<void>;
  };
}

const toProviderDraft = (view: PlatformAiProviderDraftView): AiProviderDraft =>
  aiProviderDraftSchema.parse(view);

const toModelDraft = (row: PlatformAiModelItem) =>
  aiModelDraftSchema.parse({
    abilities: row.abilities ?? {},
    config: row.config ?? null,
    contextWindowTokens: row.contextWindowTokens ?? null,
    description: row.description ?? null,
    displayName: row.displayName ?? null,
    enabled: row.enabled,
    id: row.id,
    modelKey: row.modelKey,
    parameters: row.parameters ?? {},
    pricing: row.pricing ?? null,
    providerId: row.providerId,
    revision: row.revision,
    settings: row.settings ?? {},
    sort: row.sort,
    status: row.status,
    type: row.type,
  });

export class AiCatalogAdminService {
  private readonly connectionTests: AiCatalogConnectionTestService;
  private readonly db: LobeChatDatabase;
  private readonly lifecycle: NonNullable<AiCatalogAdminServiceOptions['lifecycle']>;
  private readonly publication: AiCatalogPublicationService;
  private readonly secrets: AiCatalogSecretManager;

  constructor(
    db: LobeChatDatabase,
    secretService: PlatformSecretService,
    options: AiCatalogAdminServiceOptions = {},
  ) {
    this.db = db;
    this.connectionTests = new AiCatalogConnectionTestService(options.connectionProbe);
    this.lifecycle = options.lifecycle ?? {};
    this.secrets = new AiCatalogSecretManager(secretService);
    this.publication = new AiCatalogPublicationService(db, this.secrets, {
      invalidation: options.invalidation,
      lifecycle: options.lifecycle,
    });
  }

  private sanitizeReason = async (
    reason: string,
    providerId?: string,
    secretMutation?: AiSecretMutation,
  ): Promise<string> => {
    const credentialValues: unknown[] = [];
    if (secretMutation?.operation === 'replace' || secretMutation?.operation === 'merge') {
      credentialValues.push(secretMutation.value);
    }
    if (providerId) {
      const provider = await new PlatformAiCatalogRepository(this.db).getProvider(providerId);
      if (provider?.encryptedKeyVaults) {
        try {
          credentialValues.push(await this.secrets.decrypt(provider.encryptedKeyVaults));
        } catch {
          // Persisted text still receives generic shape redaction below.
        }
      }
    }
    return sanitizeAiCatalogPersistedText(reason, credentialValues);
  };

  private getLockedDraft = (
    tx: Parameters<typeof getLockedAiCatalogDraft>[0]['tx'],
    providerId: string,
    expectedDraftToken: string,
    expectedRevision?: number,
  ) =>
    getLockedAiCatalogDraft({
      afterLock: this.lifecycle.afterDraftLock,
      expectedDraftToken,
      expectedRevision,
      providerId,
      tx,
    });

  private appendFailureAudit = (params: {
    action: string;
    actorUserId: string;
    reason: string;
    targetId?: string;
  }) => appendAiCatalogFailureAudit(this.db, params);

  getDetail = async (providerId: string) => {
    const model = new PlatformAiCatalogModel(this.db);
    const draft = await model.getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    const publishedCatalog = await new AiCatalogReadService(this.db).getPublished();
    const published =
      publishedCatalog.providers.find((provider) => provider.providerKey === draft.providerKey) ??
      null;
    return {
      baseRevision: draft.revision,
      draft: toProviderDraft(draft),
      draftToken: aiCatalogDraftToken(draft),
      published,
    };
  };

  listRevisionHistory = async (params: { beforeRevision?: number; id: string; limit?: number }) => {
    const repository = new PlatformAiCatalogRepository(this.db);
    if (!(await repository.getProvider(params.id))) throw new AiCatalogNotFoundError();
    return repository.listProviderRevisionMetadata({
      beforeRevision: params.beforeRevision,
      limit: params.limit,
      providerId: params.id,
    });
  };

  getModelDraftContext = async (providerId: string) => {
    const draft = await new PlatformAiCatalogModel(this.db).getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    return {
      baseRevision: draft.revision,
      draftToken: aiCatalogDraftToken(draft),
      modelIds: draft.models.map((model) => model.id),
      providerId,
    };
  };

  listModelCreateTargets = async (params: { cursor?: string; limit?: number; query?: string }) => {
    const page = await new PlatformAiCatalogModel(this.db).listProviders(params);
    return {
      items: page.items.map(({ displayName, id, providerKey }) => ({
        displayName,
        id,
        providerKey,
      })),
      nextCursor: page.nextCursor,
    };
  };

  createProviderDraft = async (
    actorUserId: string,
    input: CreateProviderInput,
  ): Promise<AiProviderDraft> => {
    const { reason: rawReason, secret, ...values } = input;
    const reason = await this.sanitizeReason(rawReason, undefined, secret);
    try {
      const settings = (values.settings ?? {}) as PlatformAiProviderSettings;
      const runtimeProvider = validateAiCatalogRuntimeProvider(
        values.providerKey,
        settings,
        values.source,
      );
      if (secret?.operation === 'replace' || secret?.operation === 'merge') {
        validateAiCatalogCredentialShape(
          runtimeProvider,
          typeof secret.value === 'string' ? { apiKey: secret.value } : secret.value,
        );
      }
      const keyVaults = await this.secrets.resolveMutationKeyVaults(null, secret);
      assertAiCatalogPublicFieldsExcludeCredentials(values, keyVaults);
      const appliedSecret = await this.secrets.applyMutation(null, secret);
      return await this.db.transaction(async (tx) => {
        const repository = new PlatformAiCatalogRepository(tx);
        const row = await repository.createProvider({
          ...values,
          ...appliedSecret,
          config: values.config as PlatformAiProviderConfig | undefined,
          createdBy: actorUserId,
          settings,
          status: 'draft',
          updatedBy: actorUserId,
        });
        if (
          appliedSecret.encryptedKeyVaults &&
          appliedSecret.secretFingerprint &&
          appliedSecret.secretKeyId
        ) {
          await repository.storeProviderSecretVersion({
            ciphertext: appliedSecret.encryptedKeyVaults,
            fingerprint: appliedSecret.secretFingerprint,
            keyId: appliedSecret.secretKeyId,
            keyVersion: appliedSecret.secretKeyVersion ?? 1,
            providerId: row.id,
          });
        }
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.createDraft',
          actorUserId,
          afterDiff: { providerId: row.id, providerKey: row.providerKey },
          reason,
          result: 'success',
          targetId: row.id,
          targetType: 'provider',
        });
        const draft = await new PlatformAiCatalogModel(tx).getProvider(row.id);
        if (!draft) throw new AiCatalogNotFoundError();
        return toProviderDraft(draft);
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.createDraft',
        actorUserId,
        reason,
      });
      throw error;
    }
  };

  updateProviderDraft = async (
    actorUserId: string,
    input: UpdateProviderInput,
  ): Promise<AiProviderDraft> => {
    const {
      expectedDraftToken,
      expectedRevision,
      id,
      reason: rawReason,
      secret,
      ...values
    } = input;
    const reason = await this.sanitizeReason(rawReason, id, secret);
    try {
      return await this.db.transaction(async (tx) => {
        const before = await this.getLockedDraft(tx, id, expectedDraftToken, expectedRevision);
        const repository = new PlatformAiCatalogRepository(tx);
        const current = await repository.getProvider(id);
        if (!current) throw new AiCatalogNotFoundError();
        const settings = (values.settings ?? before.settings) as PlatformAiProviderSettings;
        const runtimeProvider = validateAiCatalogRuntimeProvider(
          before.providerKey,
          settings,
          before.source,
        );
        if (secret?.operation === 'replace' || secret?.operation === 'merge') {
          validateAiCatalogCredentialShape(
            runtimeProvider,
            typeof secret.value === 'string' ? { apiKey: secret.value } : secret.value,
          );
        }
        const keyVaults = await this.secrets.resolveMutationKeyVaults(current, secret);
        assertAiCatalogPublicFieldsExcludeCredentials(
          { ...before, ...values, models: before.models },
          keyVaults,
        );
        const appliedSecret = await this.secrets.applyMutation(current, secret);
        await repository.updateProvider(id, {
          ...values,
          ...appliedSecret,
          config: values.config as PlatformAiProviderConfig | undefined,
          settings,
          status: 'draft',
          updatedBy: actorUserId,
        });
        if (
          appliedSecret.encryptedKeyVaults &&
          appliedSecret.secretFingerprint &&
          appliedSecret.secretKeyId
        ) {
          await repository.storeProviderSecretVersion({
            ciphertext: appliedSecret.encryptedKeyVaults,
            fingerprint: appliedSecret.secretFingerprint,
            keyId: appliedSecret.secretKeyId,
            keyVersion: appliedSecret.secretKeyVersion ?? 1,
            providerId: id,
          });
        }
        const after = await new PlatformAiCatalogModel(tx).getProvider(id);
        if (!after) throw new AiCatalogNotFoundError();
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.updateDraft',
          actorUserId,
          afterDiff: { draft: after },
          beforeDiff: { draft: before },
          configRevision: after.revision,
          reason,
          result: 'success',
          targetId: id,
          targetType: 'provider',
        });
        return toProviderDraft(after);
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.updateDraft',
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  createModel = async (actorUserId: string, input: CreateModelInput) => {
    const { expectedDraftToken, providerId, reason: rawReason, ...values } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      return await this.db.transaction(async (tx) => {
        const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken);
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.getProvider(providerId);
        if (!provider) throw new AiCatalogNotFoundError();
        const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);
        assertAiCatalogPublicFieldsExcludeCredentials(values, keyVaults);
        const row = await repository.createModel({
          ...values,
          abilities: values.abilities as PlatformAiModelAbilities | undefined,
          config: values.config as PlatformAiModelConfig | null | undefined,
          createdBy: actorUserId,
          parameters: values.parameters as PlatformAiModelParameters | undefined,
          pricing: values.pricing as PlatformAiModelPricing | null | undefined,
          providerId,
          revision: draft.revision,
          settings: values.settings as PlatformAiModelSettings | undefined,
          status: 'draft',
          updatedBy: actorUserId,
        });
        await repository.updateProvider(providerId, {
          status: 'draft',
          updatedBy: actorUserId,
        });
        await new PlatformAuditService(tx).append({
          action: 'admin.aiModels.create',
          actorUserId,
          afterDiff: { modelKey: row.modelKey, providerId },
          reason,
          result: 'success',
          targetId: row.id,
          targetType: 'model',
        });
        return toModelDraft(row);
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiModels.create',
        actorUserId,
        reason,
        targetId: providerId,
      });
      throw error;
    }
  };

  getDependents = async (providerId: string, modelId: string): Promise<AiCatalogDependent[]> => {
    const repository = new PlatformAiCatalogRepository(this.db);
    const [provider, model] = await Promise.all([
      repository.getProvider(providerId),
      repository.getModel(providerId, modelId),
    ]);
    if (!provider || !model) throw new AiCatalogNotFoundError();
    return resolveAiCatalogDependents(this.db, provider.providerKey, model.modelKey);
  };

  updateModel = async (actorUserId: string, input: UpdateModelInput) => {
    const {
      expectedDraftToken,
      expectedRevision,
      id,
      providerId,
      reason: rawReason,
      ...values
    } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      return await this.db.transaction(async (tx) => {
        const draft = await this.getLockedDraft(
          tx,
          providerId,
          expectedDraftToken,
          expectedRevision,
        );
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.getProvider(providerId);
        if (!provider) throw new AiCatalogNotFoundError();
        const current = await repository.getModel(providerId, id);
        if (!current) throw new AiCatalogNotFoundError();
        const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);
        assertAiCatalogPublicFieldsExcludeCredentials({ ...current, ...values }, keyVaults);
        if (current.enabled && values.enabled === false) {
          const dependents = await resolveAiCatalogDependents(
            tx,
            draft.providerKey,
            current.modelKey,
          );
          if (dependents.some((item) => item.blocking)) {
            throw new AiCatalogResourceInUseError(dependents);
          }
        }
        const row = await repository.updateModel(providerId, id, {
          ...values,
          abilities: values.abilities as PlatformAiModelAbilities | undefined,
          config: values.config as PlatformAiModelConfig | null | undefined,
          parameters: values.parameters as PlatformAiModelParameters | undefined,
          pricing: values.pricing as PlatformAiModelPricing | null | undefined,
          settings: values.settings as PlatformAiModelSettings | undefined,
          status: 'draft',
          updatedBy: actorUserId,
        });
        if (!row) throw new AiCatalogNotFoundError();
        await repository.updateProvider(providerId, { status: 'draft', updatedBy: actorUserId });
        await new PlatformAuditService(tx).append({
          action: 'admin.aiModels.update',
          actorUserId,
          afterDiff: { modelId: id, providerId },
          reason,
          result: 'success',
          targetId: id,
          targetType: 'model',
        });
        return toModelDraft(row);
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiModels.update',
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  deleteModel = async (actorUserId: string, input: DeleteModelInput) => {
    const { expectedDraftToken, id, providerId, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      await this.db.transaction(async (tx) => {
        const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken);
        const repository = new PlatformAiCatalogRepository(tx);
        const current = await repository.getModel(providerId, id);
        if (!current) throw new AiCatalogNotFoundError();
        const dependents = await resolveAiCatalogDependents(
          tx,
          draft.providerKey,
          current.modelKey,
        );
        if (dependents.some((item) => item.blocking)) {
          throw new AiCatalogResourceInUseError(dependents);
        }
        await repository.deleteModel(providerId, id);
        await repository.updateProvider(providerId, { status: 'draft', updatedBy: actorUserId });
        await new PlatformAuditService(tx).append({
          action: 'admin.aiModels.deleteFromDraft',
          actorUserId,
          beforeDiff: { modelId: id, modelKey: current.modelKey, providerId },
          reason,
          result: 'success',
          targetId: id,
          targetType: 'model',
        });
      });
      return { deleted: true as const };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiModels.deleteFromDraft',
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  /**
   * Hard-delete a provider and every row it owns: models (RESTRICT FK), unified revision-log
   * entries (no FK), and the provider itself (encrypted secret versions cascade). Draft-only /
   * never-published providers delete freely; a provider whose models are still referenced by a
   * published agent or setting is refused with {@link AiCatalogResourceInUseError}.
   */
  deleteProvider = async (actorUserId: string, input: DeleteProviderInput) => {
    const { expectedRevision, id, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, id);
    try {
      await this.db.transaction(async (tx) => {
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.lockProvider(id);
        if (!provider) throw new AiCatalogNotFoundError();
        if (typeof expectedRevision === 'number' && provider.revision !== expectedRevision) {
          throw new PlatformRevisionConflictError('Provider changed before delete', {
            currentRevision: provider.revision,
            expectedRevision,
            resourceId: id,
            resourceType: 'provider',
          });
        }
        // Refuse when any owned model is still referenced by a published agent / setting.
        const models = await repository.listModels(id);
        const dependents: AiCatalogDependent[] = [];
        for (const model of models) {
          const modelDependents = await resolveAiCatalogDependents(
            tx,
            provider.providerKey,
            model.modelKey,
          );
          dependents.push(...modelDependents);
        }
        if (dependents.some((item) => item.blocking)) {
          throw new AiCatalogResourceInUseError(dependents);
        }
        await repository.deleteProviderModels(id);
        await repository.deleteProviderRevisions(id);
        await repository.deleteProvider(id);
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.delete',
          actorUserId,
          beforeDiff: {
            modelCount: models.length,
            providerId: id,
            providerKey: provider.providerKey,
          },
          reason,
          result: 'success',
          targetId: id,
          targetType: 'provider',
        });
      });
      return { deleted: true as const };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.delete',
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  reorderModels = async (actorUserId: string, input: ReorderModelsInput) => {
    const { expectedDraftToken, items, providerId, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      return await this.db.transaction(async (tx) => {
        await this.getLockedDraft(tx, providerId, expectedDraftToken);
        const repository = new PlatformAiCatalogRepository(tx);
        const current = await repository.listModels(providerId);
        const requestedIds = new Set(items.map((item) => item.id));
        if (
          requestedIds.size !== items.length ||
          current.length !== items.length ||
          current.some((model) => !requestedIds.has(model.id))
        ) {
          throw new PlatformRevisionConflictError(
            'Reorder must contain the complete provider draft model collection',
          );
        }
        const updated = await repository.reorderModels(providerId, items);
        if (updated !== current.length) {
          throw new PlatformRevisionConflictError('Model collection changed during reorder');
        }
        await repository.updateProvider(providerId, { status: 'draft', updatedBy: actorUserId });
        const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
        if (!draft) throw new AiCatalogNotFoundError();
        await new PlatformAuditService(tx).append({
          action: 'admin.aiModels.reorder',
          actorUserId,
          afterDiff: { items: items.map(({ id, sort }) => ({ id, sort })) },
          reason,
          result: 'success',
          targetId: providerId,
          targetType: 'provider',
        });
        return { draftToken: aiCatalogDraftToken(draft), updated };
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiModels.reorder',
        actorUserId,
        reason,
        targetId: providerId,
      });
      throw error;
    }
  };

  testProvider = async (
    actorUserId: string,
    input: { id: string; reason: string },
  ): Promise<AiConnectionTestResult> => {
    const reason = await this.sanitizeReason(input.reason, input.id);
    try {
      const snapshot = await this.db.transaction(async (tx) => {
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.lockProvider(input.id);
        if (!provider) throw new AiCatalogNotFoundError();
        const draft = await new PlatformAiCatalogModel(tx).getProvider(input.id);
        if (!draft) throw new AiCatalogNotFoundError();
        const attemptId = randomUUID();
        const testedAt = new Date();
        const testedDraftToken = aiCatalogDraftToken(draft);
        await repository.updateProvider(input.id, {
          connectionTestAttemptId: attemptId,
          connectionTestErrorCategory: null,
          connectionTestLatencyMs: null,
          connectionTestSanitizedMessage: 'Connection test in progress',
          connectionTestStatus: 'pending',
          connectionTestedAt: testedAt,
          connectionTestedDraftToken: testedDraftToken,
          connectionTestedRevision: draft.revision,
        });
        const checkModel = draft.models.find(
          (model) => model.enabled && model.modelKey === provider.checkModel,
        );
        return { attemptId, checkModelExecutable: checkModel?.type === 'chat', provider };
      });
      let result: AiConnectionTestResult;
      if (!snapshot.checkModelExecutable) {
        result = {
          errorCategory: 'invalid_config',
          latencyMs: 0,
          sanitizedMessage: 'Connection failed: invalid provider configuration',
          status: 'failure',
          testedAt: new Date(),
        };
      } else
        try {
          const keyVaults = snapshot.provider.encryptedKeyVaults
            ? await this.secrets.decrypt(snapshot.provider.encryptedKeyVaults)
            : {};
          const normalized = normalizeAiCatalogExecutionCredentials({
            config: snapshot.provider.config,
            keyVaults,
            providerKey: snapshot.provider.providerKey,
            source: snapshot.provider.source,
            settings: snapshot.provider.settings,
          });
          result = await this.connectionTests.test({
            keyVaults: normalized.keyVaults,
            provider: snapshot.provider,
            runtimeProvider: normalized.runtimeProvider,
          });
        } catch {
          result = {
            errorCategory: 'invalid_config',
            latencyMs: 0,
            sanitizedMessage: 'Connection failed: invalid provider configuration',
            status: 'failure',
            testedAt: new Date(),
          };
        }
      await new PlatformAiCatalogRepository(this.db).completeProviderConnectionTest(
        input.id,
        snapshot.attemptId,
        {
          connectionTestErrorCategory: result.errorCategory,
          connectionTestLatencyMs: result.latencyMs,
          connectionTestSanitizedMessage: result.sanitizedMessage,
          connectionTestStatus: result.status,
          connectionTestedAt: result.testedAt,
        },
      );
      await new PlatformAuditService(this.db).append({
        action: 'admin.aiProviders.test',
        actorUserId,
        afterDiff: {
          errorCategory: result.errorCategory,
          latencyMs: result.latencyMs,
          status: result.status,
        },
        reason,
        result: result.status === 'success' ? 'success' : 'failure',
        targetId: input.id,
        targetType: 'provider',
      });
      return result;
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.test',
        actorUserId,
        reason,
        targetId: input.id,
      });
      throw error;
    }
  };

  publishProvider: AiCatalogPublicationService['publishProvider'] = (actorUserId, input) =>
    this.publication.publishProvider(actorUserId, input);

  archiveProvider: AiCatalogPublicationService['archiveProvider'] = (actorUserId, input) =>
    this.publication.archiveProvider(actorUserId, input);

  rollbackProvider: AiCatalogPublicationService['rollbackProvider'] = (actorUserId, input) =>
    this.publication.rollbackProvider(actorUserId, input);

  /**
   * For first publish (revision 0): re-run connectivity test when credentials + ≥1
   * enabled model are present so applyImmediate can land without a separate UI test step.
   * revision > 0 skips auto retest (allowStaleConnectionTest handles non-secret edits).
   */
  private prepareFirstPublishConnectionTest = async (
    actorUserId: string,
    providerId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const detail = await this.getDetail(providerId);
    if (detail.baseRevision > 0) return { ok: true };
    const hasEnabledModel = detail.draft.models.some((m) => m.enabled);
    const hasCredentials = detail.draft.secret.configured;
    if (!hasEnabledModel || !hasCredentials) {
      return {
        ok: false,
        reason: !hasEnabledModel
          ? 'At least one model must be enabled before first publish'
          : 'Provider secret must be configured before first publish',
      };
    }
    const test = await this.testProvider(actorUserId, { id: providerId, reason });
    if (test.status !== 'success') {
      return {
        ok: false,
        reason: test.sanitizedMessage || 'Connection test failed before first publish',
      };
    }
    return { ok: true };
  };

  private tryPublishImmediate = async (
    actorUserId: string,
    providerId: string,
    reason: string,
    options?: { softFail?: boolean },
  ) => {
    let detail = await this.getDetail(providerId);

    if (detail.baseRevision === 0) {
      const prep = await this.prepareFirstPublishConnectionTest(actorUserId, providerId, reason);
      if (!prep.ok) {
        detail = await this.getDetail(providerId);
        return {
          auditId: null as string | null,
          draft: detail.draft,
          published: false,
          publishError: prep.reason,
          revision: detail.baseRevision,
        };
      }
      detail = await this.getDetail(providerId);
    }

    try {
      const published = await this.publishProvider(actorUserId, {
        allowStaleConnectionTest: detail.baseRevision > 0,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason,
      });
      const after = await this.getDetail(providerId);
      return {
        auditId: published.auditId as string | null,
        draft: after.draft,
        published: true,
        publishError: null as string | null,
        revision: published.revision,
      };
    } catch (error) {
      if (options?.softFail || error instanceof AiCatalogValidationError) {
        const after = await this.getDetail(providerId);
        const reasonText =
          error instanceof AiCatalogValidationError
            ? error.issues.join('; ')
            : error instanceof Error
              ? error.message
              : 'Publish failed';
        if (options?.softFail || after.baseRevision === 0) {
          return {
            auditId: null as string | null,
            draft: after.draft,
            published: false,
            publishError: reasonText,
            revision: after.baseRevision,
          };
        }
      }
      throw error;
    }
  };

  /**
   * Apply a provider draft mutation then publish immediately.
   * Sequential (draft then publish); publish failure leaves a visible draft (no silent half-state).
   */
  applyProviderImmediate = async (
    actorUserId: string,
    input: (CreateProviderInput & { mode: 'create' }) | (UpdateProviderInput & { mode: 'update' }),
  ) => {
    let providerId: string;
    if (input.mode === 'create') {
      const { mode: _mode, ...createInput } = input;
      const draft = await this.createProviderDraft(actorUserId, createInput);
      providerId = draft.id;
    } else {
      const { mode: _mode, ...updateInput } = input;
      await this.updateProviderDraft(actorUserId, updateInput);
      providerId = input.id;
    }

    // Create always soft-fails publish validation; updates soft-fail only on first-publish path
    // (revision 0). Already-published update failures still throw for UI visibility (M1).
    const softFail = input.mode === 'create';
    const result = await this.tryPublishImmediate(actorUserId, providerId, input.reason, {
      softFail,
    });
    // For update on revision>0 that fails validation, rethrow so adapter/toast surfaces it.
    if (!result.published && input.mode === 'update') {
      const after = await this.getDetail(providerId);
      if (after.baseRevision > 0 && result.publishError) {
        throw new AiCatalogValidationError([result.publishError]);
      }
    }
    return {
      auditId: result.auditId,
      draft: result.draft,
      published: result.published,
      publishError: result.publishError,
      revision: result.revision,
    };
  };

  /**
   * Retry publish for banner (re-run connection test when revision === 0, then publish).
   */
  publishNow = async (actorUserId: string, input: { id: string; reason: string }) => {
    return this.tryPublishImmediate(actorUserId, input.id, input.reason, { softFail: true });
  };

  /**
   * Apply a model draft mutation (or batch) then publish the parent provider immediately.
   * One rate-limit unit; publish failure is visible (draft retained).
   */
  applyModelImmediate = async (
    actorUserId: string,
    input: {
      enabled?: boolean;
      expectedDraftToken: string;
      expectedRevision?: number;
      id?: string;
      items?: Array<{ id: string; sort: number }>;
      modelIds?: string[];
      modelKey?: string;
      models?: Array<Record<string, unknown> & { id: string }>;
      operation:
        'batchToggle' | 'batchUpdate' | 'clear' | 'create' | 'delete' | 'reorder' | 'update';
      providerId: string;
      reason: string;
      [key: string]: unknown;
    },
  ) => {
    const { operation, providerId, reason, expectedDraftToken } = input;
    const token = expectedDraftToken;

    switch (operation) {
      case 'create': {
        const { operation: _o, ...rest } = input;
        await this.createModel(actorUserId, {
          ...(rest as CreateModelInput),
          expectedDraftToken: token,
          modelKey: input.modelKey!,
          providerId,
          reason,
        });
        break;
      }
      case 'update': {
        const { operation: _o, ...rest } = input;
        await this.updateModel(actorUserId, {
          ...(rest as UpdateModelInput),
          expectedDraftToken: token,
          expectedRevision: input.expectedRevision!,
          id: input.id!,
          providerId,
          reason,
        });
        break;
      }
      case 'delete': {
        await this.deleteModel(actorUserId, {
          expectedDraftToken: token,
          id: input.id!,
          providerId,
          reason,
        });
        break;
      }
      case 'reorder': {
        await this.reorderModels(actorUserId, {
          expectedDraftToken: token,
          items: input.items!,
          providerId,
          reason,
        });
        break;
      }
      case 'batchToggle': {
        // Single detail snapshot for model map; refresh draft token per mutation only.
        let snapshot = await this.getDetail(providerId);
        let draftToken = snapshot.draftToken;
        const modelsById = new Map(snapshot.draft.models.map((m) => [m.id, m]));
        for (const modelId of input.modelIds ?? []) {
          const model = modelsById.get(modelId);
          if (!model) throw new AiCatalogNotFoundError();
          await this.updateModel(actorUserId, {
            enabled: input.enabled!,
            expectedDraftToken: draftToken,
            expectedRevision: model.revision,
            id: modelId,
            providerId,
            reason,
          });
          snapshot = await this.getDetail(providerId);
          draftToken = snapshot.draftToken;
          for (const m of snapshot.draft.models) modelsById.set(m.id, m);
        }
        break;
      }
      case 'batchUpdate': {
        let snapshot = await this.getDetail(providerId);
        let draftToken = snapshot.draftToken;
        const modelsById = new Map(snapshot.draft.models.map((m) => [m.id, m]));
        for (const item of input.models ?? []) {
          const current = modelsById.get(item.id);
          if (!current) {
            await this.createModel(actorUserId, {
              abilities: item.abilities as CreateModelInput['abilities'],
              config: item.config as CreateModelInput['config'],
              contextWindowTokens:
                item.contextWindowTokens as CreateModelInput['contextWindowTokens'],
              description: item.description as CreateModelInput['description'],
              displayName: item.displayName as CreateModelInput['displayName'],
              enabled: item.enabled as CreateModelInput['enabled'],
              expectedDraftToken: draftToken,
              modelKey: item.id,
              parameters: item.parameters as CreateModelInput['parameters'],
              pricing: item.pricing as CreateModelInput['pricing'],
              providerId,
              reason,
              settings: item.settings as CreateModelInput['settings'],
              type: item.type as CreateModelInput['type'],
            });
          } else {
            await this.updateModel(actorUserId, {
              abilities: item.abilities as UpdateModelInput['abilities'],
              config: item.config as UpdateModelInput['config'],
              contextWindowTokens:
                item.contextWindowTokens as UpdateModelInput['contextWindowTokens'],
              description: item.description as UpdateModelInput['description'],
              displayName: item.displayName as UpdateModelInput['displayName'],
              enabled: item.enabled as UpdateModelInput['enabled'],
              expectedDraftToken: draftToken,
              expectedRevision: current.revision,
              id: item.id,
              parameters: item.parameters as UpdateModelInput['parameters'],
              pricing: item.pricing as UpdateModelInput['pricing'],
              providerId,
              reason,
              settings: item.settings as UpdateModelInput['settings'],
              type: item.type as UpdateModelInput['type'],
            });
          }
          snapshot = await this.getDetail(providerId);
          draftToken = snapshot.draftToken;
          modelsById.clear();
          for (const m of snapshot.draft.models) modelsById.set(m.id, m);
        }
        break;
      }
      case 'clear': {
        let snapshot = await this.getDetail(providerId);
        const modelIds = snapshot.draft.models.map((m) => m.id);
        for (const modelId of modelIds) {
          await this.deleteModel(actorUserId, {
            expectedDraftToken: snapshot.draftToken,
            id: modelId,
            providerId,
            reason,
          });
          snapshot = await this.getDetail(providerId);
        }
        break;
      }
      default: {
        throw new AiCatalogValidationError([`Unsupported model apply operation: ${operation}`]);
      }
    }

    const publishResult = await this.tryPublishImmediate(actorUserId, providerId, reason, {
      softFail: true,
    });
    const after = await this.getDetail(providerId);
    return {
      auditId: publishResult.auditId,
      draftToken: after.draftToken,
      published: publishResult.published,
      publishError: publishResult.publishError,
      revision: publishResult.revision,
    };
  };
}

export {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
