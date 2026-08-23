import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';

import type { AdminAiModelApplyImmediateInput } from '../../contracts/aiCatalog';
import {
  AiCatalogAdminServiceModelCrudOps,
  type AiCatalogModelApplyCapabilities,
} from './adminService.models.crud';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependentsForModels } from './dependencies';
import { AiCatalogNotFoundError, AiCatalogResourceInUseError } from './errors';
import { buildBatchModelAuditEntries, modelBatchDml, planBatchModelWrites } from './modelBatchDml';

type ApplyImmediateBatchToggle = Extract<
  AdminAiModelApplyImmediateInput,
  { operation: 'batchToggle' }
>;
type ApplyImmediateBatchUpdate = Extract<
  AdminAiModelApplyImmediateInput,
  { operation: 'batchUpdate' }
>;
type ApplyImmediateClear = Extract<AdminAiModelApplyImmediateInput, { operation: 'clear' }>;

const uniqueIdsInOrder = (ids: readonly string[]): string[] => {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
};

export abstract class AiCatalogAdminServiceModelBatchOps extends AiCatalogAdminServiceModelCrudOps {
  protected applyImmediateBatchToggle = async (
    actorUserId: string,
    input: ApplyImmediateBatchToggle,
  ) => {
    // One lock + one draft load; dependents once; bulk UPDATE + bulk audit (no per-row DML).
    // Input may contain duplicate ids (schema permits them). DML is unique-set;
    // RETURNING is checked against that set. Audits stay one-per-input like the
    // legacy sequential path (duplicate toggles compose to the same final state).
    const { enabled, expectedDraftToken, modelIds, providerId, reason } = input;
    const reasonText = await this.sanitizeReason(reason, providerId);
    await this.withFailureAudit(
      'admin.aiModels.batchToggle',
      actorUserId,
      reasonText,
      providerId,
      async () => {
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
          const uniqueModelIds = uniqueIdsInOrder(modelIds);
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
      },
    );
  };

  protected applyImmediateBatchUpdate = async (
    actorUserId: string,
    input: ApplyImmediateBatchUpdate,
    capabilities: AiCatalogModelApplyCapabilities,
  ) => {
    // Lock once; validate + plan in memory; bounded multi-row insert/update + bulk audit.
    const { expectedDraftToken, models, providerId, reason } = input;
    const reasonText = await this.sanitizeReason(reason, providerId);
    await this.withFailureAudit(
      'admin.aiModels.batchUpdate',
      actorUserId,
      reasonText,
      providerId,
      async () => {
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

          const { createAuditModelKeys, creates, updateAuditIds, updatesById } =
            planBatchModelWrites({
              actorUserId,
              capabilities,
              draftRevision: draft.revision,
              keyVaults,
              models,
              modelsById,
              providerId,
            });

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
          await modelBatchDml.bulkAppendAuditEntries(
            tx,
            buildBatchModelAuditEntries({
              actorUserId,
              createAuditModelKeys,
              createdByModelKey,
              models,
              modelsById,
              providerId,
              reasonText,
              updateAuditIds,
            }),
          );

          await repository.updateProvider(providerId, {
            status: 'draft',
            updatedBy: actorUserId,
          });
        });
      },
    );
  };

  protected applyImmediateClear = async (actorUserId: string, input: ApplyImmediateClear) => {
    // Lock once, batch dependency check, bulk delete + bulk audit, single provider update.
    const { expectedDraftToken, providerId, reason } = input;
    const reasonText = await this.sanitizeReason(reason, providerId);
    await this.withFailureAudit(
      'admin.aiModels.clear',
      actorUserId,
      reasonText,
      providerId,
      async () => {
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
      },
    );
  };
}
