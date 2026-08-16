import {
  getComposioAppByIdentifier,
  getLobehubConnectorProviderById,
  INTEREST_AREA_KEYS,
  isSupportedTaskTemplateCronPattern,
  TASK_TEMPLATE_CATEGORIES,
  TASK_TEMPLATE_ICONS,
} from '@lobechat/const';
import { z } from 'zod';

/**
 * Platform task-template ("任务模板") admin contracts.
 *
 * Direct-save family: every write lands immediately, guarded by a per-row `revision` CAS
 * token — there is no draft/publish pair and no `platform_resource_revisions` history.
 */

export const TASK_TEMPLATE_TITLE_MAX = 200;
export const TASK_TEMPLATE_DESCRIPTION_MAX = 1000;
export const TASK_TEMPLATE_INSTRUCTION_MAX = 8000;
export const TASK_TEMPLATE_IDENTIFIER_MAX = 120;

/** Slug grammar for manual rows and market identifiers alike. */
export const TASK_TEMPLATE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

export const TASK_TEMPLATE_MAX_CONNECTORS = 10;

/**
 * A connector reference the card can actually render.
 *
 * The user-side normalizer drops any template whose connector is unknown to `getProviderMeta`,
 * which would silently hide the whole card. Validating against the same builtin catalogs the
 * market parser uses keeps an unrenderable template from ever being stored.
 */
export const isKnownTaskTemplateConnector = (connector: {
  identifier: string;
  source: 'composio' | 'lobehub';
}): boolean =>
  connector.source === 'lobehub'
    ? Boolean(getLobehubConnectorProviderById(connector.identifier))
    : Boolean(getComposioAppByIdentifier(connector.identifier));

/**
 * Structural shape of a connector as **stored**. Deliberately catalog-agnostic.
 *
 * Read DTOs must accept whatever a past write legitimately persisted: if a provider is later
 * retired from the builtin catalogs, one historical row must not make the whole admin or public
 * list fail its output contract. Write inputs use {@link taskTemplateConnectorSchema} instead.
 */
export const storedTaskTemplateConnectorSchema = z
  .object({
    identifier: z.string().trim().min(1).max(120),
    required: z.boolean(),
    source: z.enum(['composio', 'lobehub']),
  })
  .strict();
export type AdminTaskTemplateConnector = z.infer<typeof storedTaskTemplateConnectorSchema>;

/** Write-time connector: it must also exist in the current catalogs. */
export const taskTemplateConnectorSchema = storedTaskTemplateConnectorSchema.refine(
  isKnownTaskTemplateConnector,
  { message: 'unknown task template connector' },
);

/** 5-field cron restricted to minute/hour/weekday (day-of-month and month must be `*`). */
export const taskTemplateCronSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(isSupportedTaskTemplateCronPattern, {
    message: 'unsupported task template cron pattern',
  });

/** Accepted on the way **in**: current catalogs, current limits. */
const taskTemplateWritableFields = {
  category: z.enum(TASK_TEMPLATE_CATEGORIES),
  connectors: z.array(taskTemplateConnectorSchema).max(TASK_TEMPLATE_MAX_CONNECTORS),
  cronPattern: taskTemplateCronSchema,
  description: z.string().trim().max(TASK_TEMPLATE_DESCRIPTION_MAX),
  enabled: z.boolean(),
  icon: z.enum(TASK_TEMPLATE_ICONS).nullable(),
  instruction: z.string().trim().min(1).max(TASK_TEMPLATE_INSTRUCTION_MAX),
  interests: z.array(z.enum(INTEREST_AREA_KEYS)).max(INTEREST_AREA_KEYS.length),
  sortOrder: z.number().int().min(0).max(9999),
  title: z.string().trim().min(1).max(TASK_TEMPLATE_TITLE_MAX),
} as const;

/**
 * Reported on the way **out**: whatever is stored, so a row written under older limits or
 * against a since-retired connector stays visible (and therefore fixable) in the console.
 * Enum-typed columns are already coerced to safe values by the row → DTO mapper.
 */
const taskTemplateReadableFields = {
  category: z.enum(TASK_TEMPLATE_CATEGORIES),
  connectors: z.array(storedTaskTemplateConnectorSchema),
  cronPattern: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  icon: z.enum(TASK_TEMPLATE_ICONS).nullable(),
  instruction: z.string(),
  interests: z.array(z.enum(INTEREST_AREA_KEYS)),
  sortOrder: z.number().int(),
  title: z.string(),
} as const;

export const adminTaskTemplateItemSchema = z
  .object({
    ...taskTemplateReadableFields,
    id: z.string(),
    identifier: z.string(),
    revision: z.number().int().nonnegative(),
    source: z.enum(['manual', 'market']),
    updatedAt: z.date(),
  })
  .strict();
export type AdminTaskTemplateItem = z.infer<typeof adminTaskTemplateItemSchema>;

export const adminTaskTemplateListInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
    query: z.string().trim().max(200).optional(),
  })
  .strict();
export type AdminTaskTemplateListInput = z.input<typeof adminTaskTemplateListInputSchema>;

export const adminTaskTemplateListOutputSchema = z
  .object({
    items: z.array(adminTaskTemplateItemSchema),
    /** Row count ignoring filters — zero means the module has never been used. */
    totalAll: z.number().int().nonnegative(),
    totalFiltered: z.number().int().nonnegative(),
  })
  .strict();
export type AdminTaskTemplateListOutput = z.infer<typeof adminTaskTemplateListOutputSchema>;

export const adminTaskTemplateCreateInputSchema = z
  .object({
    ...taskTemplateWritableFields,
    /** Optional explicit slug; auto-generated from the title when omitted. */
    identifier: z
      .string()
      .trim()
      .max(TASK_TEMPLATE_IDENTIFIER_MAX)
      .regex(TASK_TEMPLATE_IDENTIFIER_PATTERN, 'identifier must be a lowercase slug')
      .optional(),
  })
  .strict();
export type AdminTaskTemplateCreateInput = z.infer<typeof adminTaskTemplateCreateInputSchema>;

export const adminTaskTemplateUpdateInputSchema = z
  .object({
    ...taskTemplateWritableFields,
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(64),
  })
  .strict();
export type AdminTaskTemplateUpdateInput = z.infer<typeof adminTaskTemplateUpdateInputSchema>;

/** Toggling is a write like any other, so it carries the same per-row CAS token. */
export const adminTaskTemplateSetEnabledInputSchema = z
  .object({
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(64),
  })
  .strict();
export type AdminTaskTemplateSetEnabledInput = z.infer<
  typeof adminTaskTemplateSetEnabledInputSchema
>;

export const adminTaskTemplateDeleteInputSchema = z
  .object({ expectedRevision: z.number().int().nonnegative(), id: z.string().min(1).max(64) })
  .strict();
export type AdminTaskTemplateDeleteInput = z.infer<typeof adminTaskTemplateDeleteInputSchema>;

export const adminTaskTemplateDeleteOutputSchema = z.object({ id: z.string() }).strict();
export type AdminTaskTemplateDeleteOutput = z.infer<typeof adminTaskTemplateDeleteOutputSchema>;

export const adminTaskTemplateImportInputSchema = z
  .object({
    /** Locale forwarded to the market so imported copy matches the operator's console. */
    locale: z.string().trim().max(32).optional(),
  })
  .strict();
export type AdminTaskTemplateImportInput = z.infer<typeof adminTaskTemplateImportInputSchema>;

/**
 * Strict per-row shape a market recommendation must satisfy to be stored locally.
 *
 * Deliberately independent of the market's own schema: it enforces **our** identifier grammar and
 * length limits so an oversized upstream title can never be persisted and then break the admin
 * list's output contract. Rows that fail are counted as `skipped`, never fatal for the batch.
 */
export const taskTemplateMarketImportRowSchema = z
  .object({
    category: z.enum(TASK_TEMPLATE_CATEGORIES),
    connectors: z.array(taskTemplateConnectorSchema).max(TASK_TEMPLATE_MAX_CONNECTORS),
    cronPattern: taskTemplateCronSchema,
    description: z.string().trim().max(TASK_TEMPLATE_DESCRIPTION_MAX),
    icon: z.enum(TASK_TEMPLATE_ICONS).nullish(),
    identifier: z
      .string()
      .trim()
      .min(1)
      .max(TASK_TEMPLATE_IDENTIFIER_MAX)
      .regex(TASK_TEMPLATE_IDENTIFIER_PATTERN, 'identifier must be a lowercase slug'),
    instruction: z.string().trim().min(1).max(TASK_TEMPLATE_INSTRUCTION_MAX),
    interests: z.array(z.enum(INTEREST_AREA_KEYS)).max(INTEREST_AREA_KEYS.length),
    title: z.string().trim().min(1).max(TASK_TEMPLATE_TITLE_MAX),
  })
  // Upstream rows carry market-only fields (numeric id, telemetry); ignore them rather than reject.
  .transform((row) => ({ ...row, icon: row.icon ?? null }));
export type TaskTemplateMarketImportRow = z.infer<typeof taskTemplateMarketImportRowSchema>;

export const adminTaskTemplateImportOutputSchema = z
  .object({
    created: z.number().int().nonnegative(),
    /** Market rows rejected by the local shape validation (unknown connector, bad cron, …). */
    skipped: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  })
  .strict();
export type AdminTaskTemplateImportOutput = z.infer<typeof adminTaskTemplateImportOutputSchema>;

/**
 * User-facing read (`platform.taskTemplates.list`).
 * `managed: false` means "keep using the market recommendations".
 */
export const platformTaskTemplateSchema = z
  .object({
    category: z.enum(TASK_TEMPLATE_CATEGORIES),
    // Structural only — the router quarantines unrenderable rows instead of failing the list.
    connectors: z.array(storedTaskTemplateConnectorSchema),
    cronPattern: z.string(),
    description: z.string(),
    icon: z.enum(TASK_TEMPLATE_ICONS).optional(),
    id: z.string(),
    identifier: z.string(),
    instruction: z.string(),
    interests: z.array(z.enum(INTEREST_AREA_KEYS)),
    title: z.string(),
  })
  .strict();
export type PlatformTaskTemplate = z.infer<typeof platformTaskTemplateSchema>;

export const platformTaskTemplateListOutputSchema = z
  .object({
    managed: z.boolean(),
    templates: z.array(platformTaskTemplateSchema),
  })
  .strict();
export type PlatformTaskTemplateListOutput = z.infer<typeof platformTaskTemplateListOutputSchema>;

export const EMPTY_PLATFORM_TASK_TEMPLATE_LIST: PlatformTaskTemplateListOutput = {
  managed: false,
  templates: [],
};
