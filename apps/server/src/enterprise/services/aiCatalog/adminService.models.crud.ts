import type { z } from 'zod';

import { PlatformAiCatalogModel, PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type PlatformAiModelAbilities,
  type PlatformAiModelConfig,
  type PlatformAiModelItem,
  type PlatformAiModelParameters,
  type PlatformAiModelPricing,
  type PlatformAiModelSettings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type adminAiModelCreateInputSchema,
  type adminAiModelDeleteInputSchema,
  type adminAiModelReorderInputSchema,
  type adminAiModelUpdateInputSchema,
  aiModelDraftSchema,
} from '../../contracts/aiCatalog';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependents } from './dependencies';
import { AiCatalogNotFoundError, AiCatalogResourceInUseError } from './errors';
import type { AiCatalogSecretManager, AiSecretMutation } from './secretManager';
import type { getLockedAiCatalogDraft } from './shared';
import { aiCatalogDraftToken } from './shared';

type CreateModelInput = z.infer<typeof adminAiModelCreateInputSchema>;
type UpdateModelInput = z.infer<typeof adminAiModelUpdateInputSchema>;
type DeleteModelInput = z.infer<typeof adminAiModelDeleteInputSchema>;
type ReorderModelsInput = z.infer<typeof adminAiModelReorderInputSchema>;

/** Caller grants that only the executing transaction can decide the need for. */
export interface AiCatalogModelApplyCapabilities {
  /** Caller holds AI_MODEL_CREATE — required for any `batchUpdate` item that inserts. */
  allowModelCreate: boolean;
}

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

/**
 * Host fields/methods are abstract properties so the concrete service can supply
 * arrow-function implementations without signature friction.
 */
export abstract class AiCatalogAdminServiceModelCrudOps {
  protected abstract readonly db: LobeChatDatabase;
  protected abstract readonly secrets: AiCatalogSecretManager;
  protected abstract getLockedDraft: (
    tx: Transaction,
    providerId: string,
    expectedDraftToken: string,
    expectedRevision?: number,
  ) => ReturnType<typeof getLockedAiCatalogDraft>;
  protected abstract sanitizeReason: (
    reason: string,
    providerId?: string,
    secretMutation?: AiSecretMutation,
  ) => Promise<string>;
  protected abstract appendFailureAudit: (params: {
    action: AuditAction;
    actorUserId: string;
    reason: string;
    targetId?: string;
  }) => Promise<unknown> | unknown;

  protected withFailureAudit = async <T>(
    action: AuditAction,
    actorUserId: string,
    reasonText: string,
    providerId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      await this.appendFailureAudit({
        action,
        actorUserId,
        reason: reasonText,
        targetId: providerId,
      });
      throw error;
    }
  };

  private createModelInTx = async (
    tx: Transaction,
    actorUserId: string,
    input: CreateModelInput,
    reason: string,
  ) => {
    const { expectedDraftToken, providerId, reason: _reason, ...values } = input;
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
  };

  createModel = async (actorUserId: string, input: CreateModelInput) => {
    const { providerId, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      return await this.db.transaction(async (tx) =>
        this.createModelInTx(tx, actorUserId, input, reason),
      );
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

  /** Transaction-scoped model update (shared by public update + atomic batch apply). */
  private updateModelInTx = async (
    tx: Transaction,
    actorUserId: string,
    input: UpdateModelInput,
    reason: string,
  ) => {
    const {
      expectedDraftToken,
      expectedRevision,
      id,
      providerId,
      reason: _reason,
      ...values
    } = input;
    const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken, expectedRevision);
    const repository = new PlatformAiCatalogRepository(tx);
    const provider = await repository.getProvider(providerId);
    if (!provider) throw new AiCatalogNotFoundError();
    const current = await repository.getModel(providerId, id);
    if (!current) throw new AiCatalogNotFoundError();
    const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);
    assertAiCatalogPublicFieldsExcludeCredentials({ ...current, ...values }, keyVaults);
    if (current.enabled && values.enabled === false) {
      const dependents = await resolveAiCatalogDependents(tx, draft.providerKey, current.modelKey);
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
  };

  updateModel = async (actorUserId: string, input: UpdateModelInput) => {
    const { id, providerId, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      return await this.db.transaction(async (tx) =>
        this.updateModelInTx(tx, actorUserId, input, reason),
      );
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

  /** Transaction-scoped model delete (shared by public delete + atomic batch clear). */
  private deleteModelInTx = async (
    tx: Transaction,
    actorUserId: string,
    input: DeleteModelInput,
    reason: string,
  ) => {
    const { expectedDraftToken, id, providerId } = input;
    const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken);
    const repository = new PlatformAiCatalogRepository(tx);
    const current = await repository.getModel(providerId, id);
    if (!current) throw new AiCatalogNotFoundError();
    const dependents = await resolveAiCatalogDependents(tx, draft.providerKey, current.modelKey);
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
    return { deleted: true as const };
  };

  deleteModel = async (actorUserId: string, input: DeleteModelInput) => {
    const { id, providerId, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, providerId);
    try {
      return await this.db.transaction(async (tx) =>
        this.deleteModelInTx(tx, actorUserId, input, reason),
      );
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
}
