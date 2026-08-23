import { listDefaultEnabledBuiltinModels } from '@lobechat/utils/builtinModelDefaults';
import type { z } from 'zod';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type NewPlatformAiModel,
  type PlatformAiModelAbilities,
  type PlatformAiModelParameters,
  type PlatformAiModelPricing,
  type PlatformAiModelSettings,
} from '@/database/schemas/platform';

import type {
  AdminAiModelApplyImmediateInput,
  adminAiModelCreateInputSchema,
  AiProviderDraft,
} from '../../contracts/aiCatalog';
import type { AuditAction } from '../audit/auditActionCatalog';
import { AiCatalogAdminServiceModelBatchOps } from './adminService.models.batch';
import { type AiCatalogModelApplyCapabilities } from './adminService.models.crud';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependents } from './dependencies';
import {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogValidationError,
} from './errors';
import { modelBatchDml } from './modelBatchDml';

export type { AiCatalogModelApplyCapabilities } from './adminService.models.crud';

type CreateModelInput = z.infer<typeof adminAiModelCreateInputSchema>;

type ApplyImmediateCreate = Extract<AdminAiModelApplyImmediateInput, { operation: 'create' }>;
type ApplyImmediateUpdate = Extract<AdminAiModelApplyImmediateInput, { operation: 'update' }>;
type ApplyImmediateDelete = Extract<AdminAiModelApplyImmediateInput, { operation: 'delete' }>;
type ApplyImmediateReorder = Extract<AdminAiModelApplyImmediateInput, { operation: 'reorder' }>;

/**
 * Model mutation surface of {@link AiCatalogAdminService}.
 * Split from the provider-lifecycle surface to stay under the ~800-line guideline.
 *
 * Host fields/methods are abstract properties so the concrete service can supply
 * arrow-function implementations without signature friction.
 */
export abstract class AiCatalogAdminServiceModelOps extends AiCatalogAdminServiceModelBatchOps {
  abstract getDetail: (
    providerIdOrLookup: string | { id?: string; providerKey?: string },
  ) => Promise<{ draft: AiProviderDraft; draftToken: string }>;
  protected abstract publishAfterMutation: (
    actorUserId: string,
    providerId: string,
    reason: string,
    force?: boolean,
  ) => Promise<{ auditId: string; revision: number }>;
  protected abstract runModelApplyTransaction: <T>(
    params: {
      action: AuditAction;
      actorUserId: string;
      auditTargetId?: string;
      reason: string;
      secretTargetId?: string;
    },
    // Polymorphic `this`, not the base class: the scoped clone really is the full service, and a
    // subclass that runs a model transaction needs to reach its own protected members on it.
    run: (scoped: this) => Promise<T>,
  ) => Promise<T>;

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
}
