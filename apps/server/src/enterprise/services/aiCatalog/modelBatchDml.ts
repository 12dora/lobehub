import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import {
  type CreatePlatformAuditLogParams,
  type PlatformAiModelDraftView,
  redactSensitive,
} from '@/database/models/platform';
import {
  type NewPlatformAiModel,
  type NewPlatformAuditLog,
  type PlatformAiModelAbilities,
  type PlatformAiModelConfig,
  type PlatformAiModelItem,
  type PlatformAiModelParameters,
  type PlatformAiModelPricing,
  platformAiModels,
  type PlatformAiModelSettings,
  platformAuditLogs,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import type {
  AdminAiModelApplyImmediateInput,
  adminAiModelCreateInputSchema,
  adminAiModelUpdateInputSchema,
} from '../../contracts/aiCatalog';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { AiCatalogPermissionDeniedError } from './errors';

/** Bound multi-row insert/update/audit statements so a max batch (500) stays a handful of round-trips. */
const WRITE_CHUNK = 100;

export type BulkModelFieldPatch = {
  abilities?: PlatformAiModelAbilities;
  config?: PlatformAiModelConfig | null;
  contextWindowTokens?: number | null;
  description?: string | null;
  displayName?: string | null;
  enabled?: boolean;
  parameters?: PlatformAiModelParameters;
  pricing?: PlatformAiModelPricing | null;
  settings?: PlatformAiModelSettings;
  type?: PlatformAiModelItem['type'];
};

/**
 * Single UPDATE for a shared enabled flag (batchToggle hot path).
 * Scoped to providerId + owned model ids.
 */
export const bulkSetModelsEnabled = async (
  tx: Transaction,
  params: {
    enabled: boolean;
    modelIds: string[];
    providerId: string;
    updatedBy: string;
  },
): Promise<PlatformAiModelItem[]> => {
  const { enabled, modelIds, providerId, updatedBy } = params;
  if (modelIds.length === 0) return [];
  const rows: PlatformAiModelItem[] = [];
  for (let i = 0; i < modelIds.length; i += WRITE_CHUNK) {
    const chunk = modelIds.slice(i, i + WRITE_CHUNK);
    const updated = await tx
      .update(platformAiModels)
      .set({
        enabled,
        status: 'draft',
        updatedAt: new Date(),
        updatedBy,
      })
      .where(and(eq(platformAiModels.providerId, providerId), inArray(platformAiModels.id, chunk)))
      .returning();
    rows.push(...updated);
  }
  return rows;
};

/** Multi-row INSERT for batchUpdate create branch. */
export const bulkCreateModels = async (
  tx: Transaction,
  values: NewPlatformAiModel[],
): Promise<PlatformAiModelItem[]> => {
  if (values.length === 0) return [];
  const rows: PlatformAiModelItem[] = [];
  for (let i = 0; i < values.length; i += WRITE_CHUNK) {
    const chunk = values.slice(i, i + WRITE_CHUNK);
    const inserted = await tx.insert(platformAiModels).values(chunk).returning();
    rows.push(...inserted);
  }
  return rows;
};

/**
 * Bulk UPDATE of heterogeneous patches with final (merged) column values.
 * Omitted patch fields are left as the pre-merge value so the final row matches
 * per-item drizzle updates that skip `undefined` keys.
 */
export const bulkUpdateModelsMerged = async (
  tx: Transaction,
  providerId: string,
  updates: Array<
    {
      id: string;
      updatedBy: string;
    } & Required<{
      abilities: PlatformAiModelAbilities;
      config: PlatformAiModelConfig | null;
      contextWindowTokens: number | null;
      description: string | null;
      displayName: string | null;
      enabled: boolean;
      parameters: PlatformAiModelParameters;
      pricing: PlatformAiModelPricing | null;
      settings: PlatformAiModelSettings;
      type: PlatformAiModelItem['type'];
    }>
  >,
): Promise<PlatformAiModelItem[]> => {
  if (updates.length === 0) return [];
  const rows: PlatformAiModelItem[] = [];
  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    const chunk = updates.slice(i, i + WRITE_CHUNK);
    const ids = chunk.map((item) => item.id);
    const caseText = (pick: (item: (typeof chunk)[number]) => string | null) =>
      sql`CASE ${sql.join(
        chunk.map((item) => sql`WHEN ${platformAiModels.id} = ${item.id} THEN ${pick(item)}`),
        sql` `,
      )} END`;
    const caseBool = (pick: (item: (typeof chunk)[number]) => boolean) =>
      sql`CASE ${sql.join(
        chunk.map(
          (item) => sql`WHEN ${platformAiModels.id} = ${item.id} THEN ${pick(item)}::boolean`,
        ),
        sql` `,
      )} END`;
    const caseInt = (pick: (item: (typeof chunk)[number]) => number | null) =>
      sql`CASE ${sql.join(
        chunk.map((item) => {
          const value = pick(item);
          if (value === null) {
            return sql`WHEN ${platformAiModels.id} = ${item.id} THEN NULL::integer`;
          }
          return sql`WHEN ${platformAiModels.id} = ${item.id} THEN ${value}::integer`;
        }),
        sql` `,
      )} END`;
    const caseJson = (pick: (item: (typeof chunk)[number]) => unknown) =>
      sql`CASE ${sql.join(
        chunk.map(
          (item) =>
            sql`WHEN ${platformAiModels.id} = ${item.id} THEN ${JSON.stringify(pick(item))}::jsonb`,
        ),
        sql` `,
      )} END`;

    const updated = await tx
      .update(platformAiModels)
      .set({
        abilities: caseJson((item) => item.abilities),
        config: caseJson((item) => item.config),
        contextWindowTokens: caseInt((item) => item.contextWindowTokens),
        description: caseText((item) => item.description),
        displayName: caseText((item) => item.displayName),
        enabled: caseBool((item) => item.enabled),
        parameters: caseJson((item) => item.parameters),
        pricing: caseJson((item) => item.pricing),
        settings: caseJson((item) => item.settings),
        status: 'draft',
        type: caseText((item) => item.type) as unknown as PlatformAiModelItem['type'],
        updatedAt: new Date(),
        updatedBy: chunk[0]!.updatedBy,
      })
      .where(and(eq(platformAiModels.providerId, providerId), inArray(platformAiModels.id, ids)))
      .returning();
    rows.push(...updated);
  }
  return rows;
};

/** Single DELETE for a set of model ids under a provider (clear / scoped bulk delete). */
export const bulkDeleteModels = async (
  tx: Transaction,
  providerId: string,
  modelIds: string[],
): Promise<number> => {
  if (modelIds.length === 0) return 0;
  let deleted = 0;
  for (let i = 0; i < modelIds.length; i += WRITE_CHUNK) {
    const chunk = modelIds.slice(i, i + WRITE_CHUNK);
    const rows = await tx
      .delete(platformAiModels)
      .where(and(eq(platformAiModels.providerId, providerId), inArray(platformAiModels.id, chunk)))
      .returning({ id: platformAiModels.id });
    deleted += rows.length;
  }
  return deleted;
};

/** Multi-row audit insert (redacted), chunked. Preserves per-item audit rows. */
export const bulkAppendAuditEntries = async (
  tx: Transaction,
  entries: CreatePlatformAuditLogParams[],
): Promise<void> => {
  if (entries.length === 0) return;
  for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
    const chunk = entries.slice(i, i + WRITE_CHUNK);
    const values: NewPlatformAuditLog[] = chunk.map((params) => ({
      action: params.action,
      actorUserId: params.actorUserId ?? null,
      afterDiff: params.afterDiff
        ? (redactSensitive(params.afterDiff) as Record<string, unknown>)
        : null,
      beforeDiff: params.beforeDiff
        ? (redactSensitive(params.beforeDiff) as Record<string, unknown>)
        : null,
      configRevision: params.configRevision ?? null,
      id: params.id,
      ipHash: params.ipHash ?? null,
      reason: params.reason ?? null,
      requestId: params.requestId ?? null,
      result: params.result,
      targetId: params.targetId ?? null,
      targetType: params.targetType,
      userAgent: params.userAgent ?? null,
    }));
    await tx.insert(platformAuditLogs).values(values);
  }
};

/** Merge current draft row + partial patch into a full write payload (undefined = keep current). */
export const mergeModelUpdateFields = (
  current: {
    abilities: PlatformAiModelAbilities;
    config: PlatformAiModelConfig | null;
    contextWindowTokens: number | null;
    description: string | null;
    displayName: string | null;
    enabled: boolean;
    parameters: PlatformAiModelParameters;
    pricing: PlatformAiModelPricing | null;
    settings: PlatformAiModelSettings;
    type: PlatformAiModelItem['type'];
  },
  patch: BulkModelFieldPatch,
) => ({
  abilities: (patch.abilities ?? current.abilities) as PlatformAiModelAbilities,
  config: (patch.config !== undefined
    ? patch.config
    : current.config) as PlatformAiModelConfig | null,
  contextWindowTokens:
    patch.contextWindowTokens !== undefined
      ? patch.contextWindowTokens
      : current.contextWindowTokens,
  description: patch.description !== undefined ? patch.description : current.description,
  displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
  enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
  parameters: (patch.parameters ?? current.parameters) as PlatformAiModelParameters,
  pricing: (patch.pricing !== undefined
    ? patch.pricing
    : current.pricing) as PlatformAiModelPricing | null,
  settings: (patch.settings ?? current.settings) as PlatformAiModelSettings,
  type: (patch.type ?? current.type) as PlatformAiModelItem['type'],
});

type CreateModelInput = z.infer<typeof adminAiModelCreateInputSchema>;
type UpdateModelInput = z.infer<typeof adminAiModelUpdateInputSchema>;
type BatchUpdateModelItem = Extract<
  AdminAiModelApplyImmediateInput,
  { operation: 'batchUpdate' }
>['models'][number];

type PlannedUpdate = ReturnType<typeof mergeModelUpdateFields> & {
  id: string;
  updatedBy: string;
};

export const planBatchModelWrites = (params: {
  actorUserId: string;
  capabilities: { allowModelCreate: boolean };
  draftRevision: number;
  keyVaults: unknown;
  models: BatchUpdateModelItem[];
  modelsById: Map<string, PlatformAiModelDraftView>;
  providerId: string;
}): {
  createAuditModelKeys: string[];
  creates: NewPlatformAiModel[];
  updateAuditIds: string[];
  updatesById: Map<string, PlannedUpdate>;
} => {
  const { actorUserId, capabilities, draftRevision, keyVaults, models, modelsById, providerId } =
    params;
  const creates: NewPlatformAiModel[] = [];
  const createAuditModelKeys: string[] = [];
  // Duplicate update ids: compose patches in input order (same as sequential
  // per-item updates that re-read the row), then DML once per unique id.
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
        contextWindowTokens: item.contextWindowTokens as CreateModelInput['contextWindowTokens'],
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
        revision: draftRevision,
        settings: values.settings as PlatformAiModelSettings | undefined,
        status: 'draft',
        updatedBy: actorUserId,
      });
      createAuditModelKeys.push(item.id);
    } else {
      const values = {
        abilities: item.abilities as UpdateModelInput['abilities'],
        config: item.config as UpdateModelInput['config'],
        contextWindowTokens: item.contextWindowTokens as UpdateModelInput['contextWindowTokens'],
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

  return { createAuditModelKeys, creates, updateAuditIds, updatesById };
};

export const buildBatchModelAuditEntries = (params: {
  actorUserId: string;
  createAuditModelKeys: string[];
  createdByModelKey: Map<string, PlatformAiModelItem>;
  models: BatchUpdateModelItem[];
  modelsById: Map<string, PlatformAiModelDraftView>;
  providerId: string;
  reasonText: string;
  updateAuditIds: string[];
}): CreatePlatformAuditLogParams[] => {
  const {
    actorUserId,
    createAuditModelKeys,
    createdByModelKey,
    models,
    modelsById,
    providerId,
    reasonText,
    updateAuditIds,
  } = params;
  const auditEntries: CreatePlatformAuditLogParams[] = [];
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
  return auditEntries;
};

/**
 * Namespace object so tests can spy call counts (named ESM imports are not live-bound).
 * Production call sites use this object for the same reason.
 */
export const modelBatchDml = {
  bulkAppendAuditEntries,
  bulkCreateModels,
  bulkDeleteModels,
  bulkSetModelsEnabled,
  bulkUpdateModelsMerged,
  mergeModelUpdateFields,
};
