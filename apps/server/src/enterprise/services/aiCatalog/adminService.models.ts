import type { z } from 'zod';

import { PlatformAiCatalogModel, PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type NewPlatformAiModel,
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
import { PlatformAuditService } from '../platformAudit';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependents, resolveAiCatalogDependentsForModels } from './dependencies';
import {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
import { modelBatchDml } from './modelBatchDml';
import type { AiCatalogSecretManager, AiSecretMutation } from './secretManager';
import type { getLockedAiCatalogDraft } from './shared';
import { aiCatalogDraftToken } from './shared';

type CreateModelInput = z.infer<typeof adminAiModelCreateInputSchema>;
type UpdateModelInput = z.infer<typeof adminAiModelUpdateInputSchema>;
type DeleteModelInput = z.infer<typeof adminAiModelDeleteInputSchema>;
type ReorderModelsInput = z.infer<typeof adminAiModelReorderInputSchema>;

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
 * Model mutation surface of {@link AiCatalogAdminService}.
 * Split from the provider-lifecycle surface to stay under the ~800-line guideline.
 *
 * Host fields/methods are abstract properties so the concrete service can supply
 * arrow-function implementations without signature friction.
 */
export abstract class AiCatalogAdminServiceModelOps {
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
    action: string;
    actorUserId: string;
    reason: string;
    targetId?: string;
  }) => Promise<unknown> | unknown;
  protected abstract tryPublishImmediate: (
    actorUserId: string,
    providerId: string,
    reason: string,
    options?: { softFail?: boolean },
  ) => Promise<{
    auditId: string | null;
    draft: unknown;
    published: boolean;
    publishError: string | null;
    revision: number;
  }>;
  abstract getDetail: (
    providerIdOrLookup: string | { id?: string; providerKey?: string },
  ) => Promise<{ draftToken: string }>;

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

  getDependents = async (providerId: string, modelId: string): Promise<AiCatalogDependent[]> => {
    const repository = new PlatformAiCatalogRepository(this.db);
    const [provider, model] = await Promise.all([
      repository.getProvider(providerId),
      repository.getModel(providerId, modelId),
    ]);
    if (!provider || !model) throw new AiCatalogNotFoundError();
    return resolveAiCatalogDependents(this.db, provider.providerKey, model.modelKey);
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
        // One lock + one draft load; dependents once; bulk UPDATE + bulk audit (no per-row DML).
        // Input may contain duplicate ids (schema permits them). DML is unique-set;
        // RETURNING is checked against that set. Audits stay one-per-input like the
        // legacy sequential path (duplicate toggles compose to the same final state).
        const reasonText = await this.sanitizeReason(reason, providerId);
        try {
          await this.db.transaction(async (tx) => {
            const draft = await this.getLockedDraft(tx, providerId, token);
            const repository = new PlatformAiCatalogRepository(tx);
            const provider = await repository.getProvider(providerId);
            if (!provider) throw new AiCatalogNotFoundError();
            const modelsById = new Map(draft.models.map((m) => [m.id, m]));
            const modelIds = input.modelIds ?? [];
            for (const modelId of modelIds) {
              if (!modelsById.has(modelId)) throw new AiCatalogNotFoundError();
            }
            // Preserve first-seen order; DROP later dups for multi-row UPDATE only.
            const uniqueModelIds: string[] = [];
            const seenModelIds = new Set<string>();
            for (const modelId of modelIds) {
              if (seenModelIds.has(modelId)) continue;
              seenModelIds.add(modelId);
              uniqueModelIds.push(modelId);
            }
            if (input.enabled === false) {
              const keysToCheck = uniqueModelIds
                .map((modelId) => modelsById.get(modelId)!)
                .filter((model) => model.enabled)
                .map((model) => model.modelKey);
              if (keysToCheck.length > 0) {
                const dependents = await resolveAiCatalogDependentsForModels(
                  tx,
                  draft.providerKey,
                  keysToCheck,
                );
                if (dependents.some((item) => item.blocking)) {
                  throw new AiCatalogResourceInUseError(dependents);
                }
              }
            }
            const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);
            for (const modelId of uniqueModelIds) {
              const current = modelsById.get(modelId)!;
              assertAiCatalogPublicFieldsExcludeCredentials(
                { ...current, enabled: input.enabled! },
                keyVaults,
              );
            }
            const updated = await modelBatchDml.bulkSetModelsEnabled(tx, {
              enabled: input.enabled!,
              modelIds: uniqueModelIds,
              providerId,
              updatedBy: actorUserId,
            });
            // Never compare RETURNING to the raw (possibly duplicate) input length.
            if (updated.length !== uniqueModelIds.length) throw new AiCatalogNotFoundError();
            // Per-input audits (including duplicate targetIds) match sequential toggles.
            await modelBatchDml.bulkAppendAuditEntries(
              tx,
              modelIds.map((modelId) => ({
                action: 'admin.aiModels.update',
                actorUserId,
                afterDiff: { modelId, providerId },
                reason: reasonText,
                result: 'success' as const,
                targetId: modelId,
                targetType: 'model',
              })),
            );
            await repository.updateProvider(providerId, {
              status: 'draft',
              updatedBy: actorUserId,
            });
          });
        } catch (error) {
          await this.appendFailureAudit({
            action: 'admin.aiModels.batchToggle',
            actorUserId,
            reason: reasonText,
            targetId: providerId,
          });
          throw error;
        }
        break;
      }
      case 'batchUpdate': {
        // Lock once; validate + plan in memory; bounded multi-row insert/update + bulk audit.
        const reasonText = await this.sanitizeReason(reason, providerId);
        try {
          await this.db.transaction(async (tx) => {
            const draft = await this.getLockedDraft(tx, providerId, token);
            const repository = new PlatformAiCatalogRepository(tx);
            const provider = await repository.getProvider(providerId);
            if (!provider) throw new AiCatalogNotFoundError();
            const modelsById = new Map(draft.models.map((m) => [m.id, m]));
            const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);
            const disableKeys: string[] = [];
            for (const item of input.models ?? []) {
              const current = modelsById.get(item.id);
              if (current?.enabled && item.enabled === false) {
                disableKeys.push(current.modelKey);
              }
            }
            if (disableKeys.length > 0) {
              const dependents = await resolveAiCatalogDependentsForModels(
                tx,
                draft.providerKey,
                disableKeys,
              );
              if (dependents.some((item) => item.blocking)) {
                throw new AiCatalogResourceInUseError(dependents);
              }
            }

            const creates: NewPlatformAiModel[] = [];
            const createAuditModelKeys: string[] = [];
            // Duplicate update ids: compose patches in input order (same as sequential
            // per-item updates that re-read the row), then DML once per unique id.
            type PlannedUpdate = ReturnType<typeof modelBatchDml.mergeModelUpdateFields> & {
              id: string;
              updatedBy: string;
            };
            const updatesById = new Map<string, PlannedUpdate>();
            const updateAuditIds: string[] = [];

            for (const item of input.models ?? []) {
              const current = modelsById.get(item.id);
              if (!current) {
                // Creates keep every input row so duplicate modelKeys still hit the unique
                // constraint (same failure as sequential create-then-create).
                const values = {
                  abilities: item.abilities as CreateModelInput['abilities'],
                  config: item.config as CreateModelInput['config'],
                  contextWindowTokens:
                    item.contextWindowTokens as CreateModelInput['contextWindowTokens'],
                  description: item.description as CreateModelInput['description'],
                  displayName: item.displayName as CreateModelInput['displayName'],
                  enabled: item.enabled as CreateModelInput['enabled'],
                  modelKey: item.id,
                  parameters: item.parameters as CreateModelInput['parameters'],
                  pricing: item.pricing as CreateModelInput['pricing'],
                  settings: item.settings as CreateModelInput['settings'],
                  type: item.type as CreateModelInput['type'],
                };
                assertAiCatalogPublicFieldsExcludeCredentials(values, keyVaults);
                creates.push({
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
                createAuditModelKeys.push(item.id);
              } else {
                const values = {
                  abilities: item.abilities as UpdateModelInput['abilities'],
                  config: item.config as UpdateModelInput['config'],
                  contextWindowTokens:
                    item.contextWindowTokens as UpdateModelInput['contextWindowTokens'],
                  description: item.description as UpdateModelInput['description'],
                  displayName: item.displayName as UpdateModelInput['displayName'],
                  enabled: item.enabled as UpdateModelInput['enabled'],
                  parameters: item.parameters as UpdateModelInput['parameters'],
                  pricing: item.pricing as UpdateModelInput['pricing'],
                  settings: item.settings as UpdateModelInput['settings'],
                  type: item.type as UpdateModelInput['type'],
                };
                const base = updatesById.get(item.id) ?? current;
                const merged = modelBatchDml.mergeModelUpdateFields(base, values);
                assertAiCatalogPublicFieldsExcludeCredentials(merged, keyVaults);
                updatesById.set(item.id, {
                  id: item.id,
                  updatedBy: actorUserId,
                  ...merged,
                });
                updateAuditIds.push(item.id);
              }
            }

            const createdRows = await modelBatchDml.bulkCreateModels(tx, creates);
            if (createdRows.length !== creates.length) throw new AiCatalogNotFoundError();
            const createdByModelKey = new Map(createdRows.map((row) => [row.modelKey, row]));
            for (const modelKey of createAuditModelKeys) {
              if (!createdByModelKey.has(modelKey)) throw new AiCatalogNotFoundError();
            }

            const updates = [...updatesById.values()];
            const updatedRows = await modelBatchDml.bulkUpdateModelsMerged(tx, providerId, updates);
            // RETURNING is unique-id count; never compare to raw input length with dups.
            if (updatedRows.length !== updates.length) throw new AiCatalogNotFoundError();

            // Audits follow input order (duplicate update targets produce multiple audits).
            const auditEntries: Parameters<typeof modelBatchDml.bulkAppendAuditEntries>[1] = [];
            let createIdx = 0;
            let updateIdx = 0;
            for (const item of input.models ?? []) {
              if (modelsById.has(item.id)) {
                const modelId = updateAuditIds[updateIdx++]!;
                auditEntries.push({
                  action: 'admin.aiModels.update',
                  actorUserId,
                  afterDiff: { modelId, providerId },
                  reason: reasonText,
                  result: 'success',
                  targetId: modelId,
                  targetType: 'model',
                });
              } else {
                const modelKey = createAuditModelKeys[createIdx++]!;
                const row = createdByModelKey.get(modelKey)!;
                auditEntries.push({
                  action: 'admin.aiModels.create',
                  actorUserId,
                  afterDiff: { modelKey: row.modelKey, providerId },
                  reason: reasonText,
                  result: 'success',
                  targetId: row.id,
                  targetType: 'model',
                });
              }
            }
            await modelBatchDml.bulkAppendAuditEntries(tx, auditEntries);

            await repository.updateProvider(providerId, {
              status: 'draft',
              updatedBy: actorUserId,
            });
          });
        } catch (error) {
          await this.appendFailureAudit({
            action: 'admin.aiModels.batchUpdate',
            actorUserId,
            reason: reasonText,
            targetId: providerId,
          });
          throw error;
        }
        break;
      }
      case 'clear': {
        // Lock once, batch dependency check, bulk delete + bulk audit, single provider update.
        const reasonText = await this.sanitizeReason(reason, providerId);
        try {
          await this.db.transaction(async (tx) => {
            const draft = await this.getLockedDraft(tx, providerId, token);
            const repository = new PlatformAiCatalogRepository(tx);
            const models = draft.models;
            if (models.length === 0) return;
            const dependents = await resolveAiCatalogDependentsForModels(
              tx,
              draft.providerKey,
              models.map((model) => model.modelKey),
            );
            if (dependents.some((item) => item.blocking)) {
              throw new AiCatalogResourceInUseError(dependents);
            }
            const deleted = await modelBatchDml.bulkDeleteModels(
              tx,
              providerId,
              models.map((model) => model.id),
            );
            if (deleted !== models.length) throw new AiCatalogNotFoundError();
            await modelBatchDml.bulkAppendAuditEntries(
              tx,
              models.map((model) => ({
                action: 'admin.aiModels.deleteFromDraft',
                actorUserId,
                beforeDiff: {
                  modelId: model.id,
                  modelKey: model.modelKey,
                  providerId,
                },
                reason: reasonText,
                result: 'success' as const,
                targetId: model.id,
                targetType: 'model',
              })),
            );
            await repository.updateProvider(providerId, {
              status: 'draft',
              updatedBy: actorUserId,
            });
          });
        } catch (error) {
          await this.appendFailureAudit({
            action: 'admin.aiModels.clear',
            actorUserId,
            reason: reasonText,
            targetId: providerId,
          });
          throw error;
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
