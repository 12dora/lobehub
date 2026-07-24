import { and, eq, inArray, sql } from 'drizzle-orm';

import { type CreatePlatformAuditLogParams, redactSensitive } from '@/database/models/platform';
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
