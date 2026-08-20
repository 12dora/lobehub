import { z } from 'zod';

/**
 * Platform agent-template ("助理模板") admin contracts.
 *
 * Agent templates are the example cards shown under the user-side "create agent" modal. Until an
 * operator imports or creates one, users keep the locale-driven built-in examples
 * (`suggestQuestions:agent.NN.*`). Any row makes the platform list authoritative; only `enabled`
 * rows are served, in `sortOrder`.
 *
 * Direct-save family (same as task templates): every write lands immediately, guarded by a per-row
 * `revision` CAS token — there is no draft/publish pair and no `platform_resource_revisions` history.
 */

export const AGENT_TEMPLATE_TITLE_MAX = 200;
export const AGENT_TEMPLATE_DESCRIPTION_MAX = 1000;
export const AGENT_TEMPLATE_SYSTEM_ROLE_MAX = 20_000;
export const AGENT_TEMPLATE_IDENTIFIER_MAX = 120;
export const AGENT_TEMPLATE_AVATAR_MAX = 2000;
export const AGENT_TEMPLATE_BACKGROUND_COLOR_MAX = 64;
export const AGENT_TEMPLATE_TAG_MAX = 40;
export const AGENT_TEMPLATE_MAX_TAGS = 10;

/** Slug grammar for manual rows and built-in identifiers (`agent-01` … `agent-40`) alike. */
export const AGENT_TEMPLATE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

export const AGENT_TEMPLATE_SOURCES = ['builtin', 'manual'] as const;
export type AgentTemplateSource = (typeof AGENT_TEMPLATE_SOURCES)[number];

/** Accepted on the way **in**: current limits. */
const agentTemplateWritableFields = {
  avatar: z.string().trim().max(AGENT_TEMPLATE_AVATAR_MAX).nullable(),
  backgroundColor: z.string().trim().max(AGENT_TEMPLATE_BACKGROUND_COLOR_MAX).nullable(),
  description: z.string().trim().max(AGENT_TEMPLATE_DESCRIPTION_MAX),
  enabled: z.boolean(),
  systemRole: z.string().trim().min(1).max(AGENT_TEMPLATE_SYSTEM_ROLE_MAX),
  tags: z.array(z.string().trim().min(1).max(AGENT_TEMPLATE_TAG_MAX)).max(AGENT_TEMPLATE_MAX_TAGS),
  title: z.string().trim().min(1).max(AGENT_TEMPLATE_TITLE_MAX),
} as const;

/**
 * Reported on the way **out**: whatever is stored, so a row written under older limits stays
 * visible (and therefore fixable) in the console.
 */
const agentTemplateReadableFields = {
  avatar: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  description: z.string(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  systemRole: z.string(),
  tags: z.array(z.string()),
  title: z.string(),
} as const;

export const adminAgentTemplateItemSchema = z
  .object({
    ...agentTemplateReadableFields,
    id: z.string(),
    identifier: z.string(),
    revision: z.number().int().nonnegative(),
    source: z.enum(AGENT_TEMPLATE_SOURCES),
    updatedAt: z.date(),
  })
  .strict();
export type AdminAgentTemplateItem = z.infer<typeof adminAgentTemplateItemSchema>;

export const adminAgentTemplateListInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(100_000).default(0),
    query: z.string().trim().max(200).optional(),
  })
  .strict();
export type AdminAgentTemplateListInput = z.input<typeof adminAgentTemplateListInputSchema>;

export const adminAgentTemplateListOutputSchema = z
  .object({
    items: z.array(adminAgentTemplateItemSchema),
    /** Row count ignoring filters — zero means users still see the built-in locale examples. */
    totalAll: z.number().int().nonnegative(),
    totalFiltered: z.number().int().nonnegative(),
  })
  .strict();
export type AdminAgentTemplateListOutput = z.infer<typeof adminAgentTemplateListOutputSchema>;

export const adminAgentTemplateCreateInputSchema = z
  .object({
    ...agentTemplateWritableFields,
    /** Optional explicit slug; auto-generated from the title when omitted. */
    identifier: z
      .string()
      .trim()
      .max(AGENT_TEMPLATE_IDENTIFIER_MAX)
      .regex(AGENT_TEMPLATE_IDENTIFIER_PATTERN, 'identifier must be a lowercase slug')
      .optional(),
  })
  .strict();
export type AdminAgentTemplateCreateInput = z.infer<typeof adminAgentTemplateCreateInputSchema>;

export const adminAgentTemplateUpdateInputSchema = z
  .object({
    ...agentTemplateWritableFields,
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(64),
  })
  .strict();
export type AdminAgentTemplateUpdateInput = z.infer<typeof adminAgentTemplateUpdateInputSchema>;

/** Toggling is a write like any other, so it carries the same per-row CAS token. */
export const adminAgentTemplateSetEnabledInputSchema = z
  .object({
    enabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    id: z.string().min(1).max(64),
  })
  .strict();
export type AdminAgentTemplateSetEnabledInput = z.infer<
  typeof adminAgentTemplateSetEnabledInputSchema
>;

export const adminAgentTemplateDeleteInputSchema = z
  .object({ expectedRevision: z.number().int().nonnegative(), id: z.string().min(1).max(64) })
  .strict();
export type AdminAgentTemplateDeleteInput = z.infer<typeof adminAgentTemplateDeleteInputSchema>;

export const adminAgentTemplateDeleteOutputSchema = z.object({ id: z.string() }).strict();
export type AdminAgentTemplateDeleteOutput = z.infer<typeof adminAgentTemplateDeleteOutputSchema>;

/** Upper bound on one reorder call — the admin table's largest page size. */
export const AGENT_TEMPLATE_REORDER_MAX_ITEMS = 100;

/**
 * Display order for the rows the operator can currently see (same protocol as task templates:
 * ids of one page in their new order + each row's CAS token; the server redistributes the
 * `sortOrder` slots those rows already occupy).
 */
export const adminAgentTemplateReorderInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            expectedRevision: z.number().int().nonnegative(),
            id: z.string().min(1).max(64),
          })
          .strict(),
      )
      .min(1)
      .max(AGENT_TEMPLATE_REORDER_MAX_ITEMS),
  })
  .strict();
export type AdminAgentTemplateReorderInput = z.infer<typeof adminAgentTemplateReorderInputSchema>;

export const adminAgentTemplateReorderOutputSchema = z
  .object({ items: z.array(adminAgentTemplateItemSchema) })
  .strict();
export type AdminAgentTemplateReorderOutput = z.infer<typeof adminAgentTemplateReorderOutputSchema>;

/**
 * `admin.agentTemplates.importBuiltins` — upsert the 40 built-in create-agent examples
 * (`suggestQuestions:agent.01` … `agent.40`) as `source: 'builtin'` rows keyed by identifier
 * `agent-01` … `agent-40`. Operator `enabled` / `sortOrder` on existing rows are preserved.
 */
export const adminAgentTemplateImportInputSchema = z
  .object({
    /** Console locale; the built-in copy is resolved in that language (falls back to en-US). */
    locale: z.string().trim().max(32).optional(),
  })
  .strict();
export type AdminAgentTemplateImportInput = z.infer<typeof adminAgentTemplateImportInputSchema>;

export const adminAgentTemplateImportOutputSchema = z
  .object({
    created: z.number().int().nonnegative(),
    /** Built-in rows rejected by the local shape validation (empty title / prompt). */
    skipped: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  })
  .strict();
export type AdminAgentTemplateImportOutput = z.infer<typeof adminAgentTemplateImportOutputSchema>;

/**
 * User-facing read (`platform.agentTemplates.list`).
 * `managed: false` means "keep using the built-in locale examples".
 */
export const platformAgentTemplateSchema = z
  .object({
    avatar: z.string().nullable(),
    backgroundColor: z.string().nullable(),
    description: z.string(),
    id: z.string(),
    identifier: z.string(),
    systemRole: z.string(),
    tags: z.array(z.string()),
    title: z.string(),
  })
  .strict();
export type PlatformAgentTemplate = z.infer<typeof platformAgentTemplateSchema>;

export const platformAgentTemplateListOutputSchema = z
  .object({
    managed: z.boolean(),
    templates: z.array(platformAgentTemplateSchema),
  })
  .strict();
export type PlatformAgentTemplateListOutput = z.infer<typeof platformAgentTemplateListOutputSchema>;

export const EMPTY_PLATFORM_AGENT_TEMPLATE_LIST: PlatformAgentTemplateListOutput = {
  managed: false,
  templates: [],
};

/** Upper bound on the cards the user-side create-agent modal renders. */
export const AGENT_TEMPLATE_DISPLAY_MAX = 40;
