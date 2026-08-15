import { listDefaultEnabledBuiltinModels } from '@lobechat/utils/builtinModelDefaults';
import type { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
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
  type AdminAiModelApplyImmediateInput,
  type adminAiModelCreateInputSchema,
  type adminAiModelDeleteInputSchema,
  type adminAiModelReorderInputSchema,
  type adminAiModelUpdateInputSchema,
  aiModelDraftSchema,
} from '../../contracts/aiCatalog';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependents, resolveAiCatalogDependentsForModels } from './dependencies';
import {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogPermissionDeniedError,
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

type ApplyImmediateCreate = Extract<AdminAiModelApplyImmediateInput, { operation: 'create' }>;
type ApplyImmediateUpdate = Extract<AdminAiModelApplyImmediateInput, { operation: 'update' }>;
type ApplyImmediateDelete = Extract<AdminAiModelApplyImmediateInput, { operation: 'delete' }>;
type ApplyImmediateReorder = Extract<AdminAiModelApplyImmediateInput, { operation: 'reorder' }>;
type ApplyImmediateBatchToggle = Extract<
  AdminAiModelApplyImmediateInput,
  { operation: 'batchToggle' }
>;
type ApplyImmediateBatchUpdate = Extract<
  AdminAiModelApplyImmediateInput,
  { operation: 'batchUpdate' }
>;
type ApplyImmediateClear = Extract<AdminAiModelApplyImmediateInput, { operation: 'clear' }>;

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
    action: AuditAction;
    actorUserId: string;
    reason: string;
    targetId?: string;
  }) => Promise<unknown> | unknown;
  protected abstract publishAfterMutation: (
    actorUserId: string,
    providerId: string,
    reason: string,
  ) => Promise<{ auditId: string; revision: number }>;
  protected abstract runModelApplyTransaction: <T>(
    params: {
      action: AuditAction;
      actorUserId: string;
      auditTargetId?: string;
      reason: string;
      secretTargetId?: string;
    },
    run: (scoped: AiCatalogAdminServiceModelOps) => Promise<T>,
  ) => Promise<T>;
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

  /**
   * Seed a freshly created BUILTIN provider with the model rows its card ships as enabled.
   *
   * Why this exists: the admin model list is a merge of persisted platform rows and the
   * model-bank catalog, so a provider created with zero rows renders its card defaults with the
   * toggle already ON — while the platform serves nothing, and the connectivity check answers
   * "该模型尚未启用". The displayed state was a promise the database never made. Materializing
   * the card's default-enabled models at CREATE time makes the two agree from the first render,
   * and the check works without the operator toggling every model off and on again.
   *
   * Runs inside the caller's applyImmediate transaction (a SAVEPOINT on the scoped clone), so a
   * later publish failure rolls the seeded rows back with the provider itself — a create either
   * lands complete or leaves nothing behind.
   *
   * Idempotent: rows that already exist for a `modelKey` are skipped, never overwritten. A
   * reconnect therefore adds nothing, and an operator's own edits to a seeded row survive.
   *
   * PERMISSION: authorized by the provider-create grant that reached this transaction, NOT by
   * AI_MODEL_CREATE. The rows are not caller-authored — every field comes from the immutable
   * builtin card, and the set is exactly what creating this provider already displays as
   * enabled — so the gate that protects operator-supplied model rows (`batchUpdate`'s insert
   * branch) is not the gate for this. Requiring it here would instead make a shared-account
   * connect fail outright for an operator who legitimately holds AI_PROVIDER_CREATE. Each
   * seeded row still gets its own `admin.aiModels.create` audit, tagged
   * `materializedFrom: 'builtin_card'` so the trail distinguishes it from a hand-made model.
   */
  protected materializeBuiltinDefaultModels = async (
    actorUserId: string,
    params: { providerId: string; providerKey: string; reason: string },
  ): Promise<{ materializedModelKeys: string[] }> => {
    const { providerId, providerKey, reason } = params;
    const defaults = listDefaultEnabledBuiltinModels(providerKey);
    // A provider whose card enables nothing by default (or is not in model-bank at all) has
    // nothing honest to seed — leave it empty rather than inventing rows.
    if (defaults.length === 0) return { materializedModelKeys: [] };
    const reasonText = await this.sanitizeReason(reason, providerId);

    return this.db.transaction(async (tx) => {
      const repository = new PlatformAiCatalogRepository(tx);
      const provider = await repository.getProvider(providerId);
      if (!provider) throw new AiCatalogNotFoundError();
      const existingKeys = new Set(
        (await repository.listModels(providerId)).map((model) => model.modelKey),
      );
      const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);

      const creates: NewPlatformAiModel[] = [];
      defaults.forEach((item, index) => {
        if (existingKeys.has(item.modelKey)) return;
        const values = {
          abilities: item.abilities as CreateModelInput['abilities'],
          contextWindowTokens: item.contextWindowTokens,
          description: item.description,
          displayName: item.displayName,
          // The card said ON; that is the whole point of seeding it.
          enabled: true,
          modelKey: item.modelKey,
          parameters: item.parameters as CreateModelInput['parameters'],
          pricing: item.pricing as CreateModelInput['pricing'],
          settings: item.settings as CreateModelInput['settings'],
          // Card order, so the list reads the way the catalog presents it.
          sort: index,
          type: item.type,
        };
        assertAiCatalogPublicFieldsExcludeCredentials(values, keyVaults);
        creates.push({
          ...values,
          abilities: values.abilities as PlatformAiModelAbilities | undefined,
          createdBy: actorUserId,
          parameters: values.parameters as PlatformAiModelParameters | undefined,
          pricing: values.pricing as PlatformAiModelPricing | null | undefined,
          providerId,
          revision: provider.revision,
          settings: values.settings as PlatformAiModelSettings | undefined,
          status: 'draft',
          updatedBy: actorUserId,
        });
      });
      if (creates.length === 0) return { materializedModelKeys: [] };

      const rows = await modelBatchDml.bulkCreateModels(tx, creates);
      if (rows.length !== creates.length) throw new AiCatalogNotFoundError();
      await modelBatchDml.bulkAppendAuditEntries(
        tx,
        rows.map((row) => ({
          action: 'admin.aiModels.create',
          actorUserId,
          afterDiff: {
            materializedFrom: 'builtin_card',
            modelKey: row.modelKey,
            providerId,
          },
          reason: reasonText,
          result: 'success' as const,
          targetId: row.id,
          targetType: 'model',
        })),
      );
      return { materializedModelKeys: rows.map((row) => row.modelKey) };
    });
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

  /**
   * Atomic model mutation followed by an unconditional publish of the parent provider.
   *
   * Mutation + publish share ONE transaction, so a publish failure rolls the model DML back
   * instead of leaving model rows runtime never serves. Any failure throws.
   *
   * `capabilities.allowModelCreate` carries the caller's AI_MODEL_CREATE grant: the router's
   * compound gate can only classify the *declared* operation, and `batchUpdate` decides
   * create-vs-update from database state, so the insert branch is authorized here — inside the
   * transaction that makes the decision.
   */
  applyModelImmediate = async (
    actorUserId: string,
    input: AdminAiModelApplyImmediateInput,
    capabilities: AiCatalogModelApplyCapabilities = { allowModelCreate: true },
  ) => {
    const { providerId, reason } = input;
    const published = await this.runModelApplyTransaction(
      {
        action: 'admin.aiModels.applyImmediate',
        actorUserId,
        auditTargetId: providerId,
        reason,
        secretTargetId: providerId,
      },
      async (scoped) => {
        await scoped.applyModelMutation(actorUserId, input, capabilities);
        return scoped.publishAfterMutation(actorUserId, providerId, reason);
      },
    );
    const after = await this.getDetail(providerId);
    return {
      auditId: published.auditId,
      draftToken: after.draftToken,
      revision: published.revision,
    };
  };

  /** Per-operation dispatch; private handlers keep required fields compiler-enforced. */
  protected applyModelMutation = async (
    actorUserId: string,
    input: AdminAiModelApplyImmediateInput,
    capabilities: AiCatalogModelApplyCapabilities,
  ) => {
    switch (input.operation) {
      case 'create': {
        await this.applyImmediateCreate(actorUserId, input);
        return;
      }
      case 'update': {
        await this.applyImmediateUpdate(actorUserId, input);
        return;
      }
      case 'delete': {
        await this.applyImmediateDelete(actorUserId, input);
        return;
      }
      case 'reorder': {
        await this.applyImmediateReorder(actorUserId, input);
        return;
      }
      case 'batchToggle': {
        // Insert-free by construction: an unknown id is rejected below, never materialized.
        await this.applyImmediateBatchToggle(actorUserId, input);
        return;
      }
      case 'batchUpdate': {
        await this.applyImmediateBatchUpdate(actorUserId, input, capabilities);
        return;
      }
      case 'clear': {
        await this.applyImmediateClear(actorUserId, input);
        return;
      }
      default: {
        const _exhaustive: never = input;
        throw new AiCatalogValidationError([
          `Unsupported model apply operation: ${(_exhaustive as { operation: string }).operation}`,
        ]);
      }
    }
  };

  private applyImmediateCreate = async (actorUserId: string, input: ApplyImmediateCreate) => {
    const { operation: _operation, ...rest } = input;
    await this.createModel(actorUserId, rest);
  };

  private applyImmediateUpdate = async (actorUserId: string, input: ApplyImmediateUpdate) => {
    const { operation: _operation, ...rest } = input;
    await this.updateModel(actorUserId, rest);
  };

  private applyImmediateDelete = async (actorUserId: string, input: ApplyImmediateDelete) => {
    const { operation: _operation, ...rest } = input;
    await this.deleteModel(actorUserId, rest);
  };

  private applyImmediateReorder = async (actorUserId: string, input: ApplyImmediateReorder) => {
    const { operation: _operation, ...rest } = input;
    await this.reorderModels(actorUserId, rest);
  };

  private applyImmediateBatchToggle = async (
    actorUserId: string,
    input: ApplyImmediateBatchToggle,
  ) => {
    // One lock + one draft load; dependents once; bulk UPDATE + bulk audit (no per-row DML).
    // Input may contain duplicate ids (schema permits them). DML is unique-set;
    // RETURNING is checked against that set. Audits stay one-per-input like the
    // legacy sequential path (duplicate toggles compose to the same final state).
    const { enabled, expectedDraftToken, modelIds, providerId, reason } = input;
    const reasonText = await this.sanitizeReason(reason, providerId);
    try {
      await this.db.transaction(async (tx) => {
        const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken);
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.getProvider(providerId);
        if (!provider) throw new AiCatalogNotFoundError();
        const modelsById = new Map(draft.models.map((m) => [m.id, m]));
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
        if (enabled === false) {
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
          assertAiCatalogPublicFieldsExcludeCredentials({ ...current, enabled }, keyVaults);
        }
        const updated = await modelBatchDml.bulkSetModelsEnabled(tx, {
          enabled,
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
  };

  private applyImmediateBatchUpdate = async (
    actorUserId: string,
    input: ApplyImmediateBatchUpdate,
    capabilities: AiCatalogModelApplyCapabilities,
  ) => {
    // Lock once; validate + plan in memory; bounded multi-row insert/update + bulk audit.
    const { expectedDraftToken, models, providerId, reason } = input;
    const reasonText = await this.sanitizeReason(reason, providerId);
    try {
      await this.db.transaction(async (tx) => {
        const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken);
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.getProvider(providerId);
        if (!provider) throw new AiCatalogNotFoundError();
        const modelsById = new Map(draft.models.map((m) => [m.id, m]));
        const keyVaults = await this.secrets.resolveMutationKeyVaults(provider, undefined);
        const disableKeys: string[] = [];
        for (const item of models) {
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

        for (const item of models) {
          const current = modelsById.get(item.id);
          if (!current) {
            // An id with no platform row is an INSERT (this is how toggling a builtin
            // model-bank model materializes its first platform row). Least privilege: that
            // branch needs AI_MODEL_CREATE, which the declared `batchUpdate` operation does
            // not select — so a caller holding only UPDATE+PUBLISH is denied here.
            if (!capabilities.allowModelCreate) {
              throw new AiCatalogPermissionDeniedError(PLATFORM_PERMISSIONS.AI_MODEL_CREATE);
            }
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
        for (const item of models) {
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
  };

  private applyImmediateClear = async (actorUserId: string, input: ApplyImmediateClear) => {
    // Lock once, batch dependency check, bulk delete + bulk audit, single provider update.
    const { expectedDraftToken, providerId, reason } = input;
    const reasonText = await this.sanitizeReason(reason, providerId);
    try {
      await this.db.transaction(async (tx) => {
        const draft = await this.getLockedDraft(tx, providerId, expectedDraftToken);
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
  };
}
