import type {
  PlatformAgentTemplateImportRow,
  PlatformAgentTemplateRecord,
} from '@/database/models/platform';

import type {
  AdminAgentTemplateItem,
  AdminAgentTemplateListOutput,
  PlatformAgentTemplate,
} from '../../contracts/adminAgentTemplates';
import {
  adminAgentTemplateCreateInputSchema,
  AGENT_TEMPLATE_IDENTIFIER_MAX,
} from '../../contracts/adminAgentTemplates';
import { builtInAgentTemplatesForImport } from './builtInAgentTemplates';

/** Prefix for read-only preview ids synthesized from the bundled library. */
export const AGENT_TEMPLATE_PREVIEW_ID_PREFIX = 'preview:';

/** Fixed timestamp so preview rows stay type-valid without pretending they were written. */
const PREVIEW_UPDATED_AT = new Date(0);

const writableShape = adminAgentTemplateCreateInputSchema.omit({ identifier: true });

/** Row → admin console DTO. */
export const toAdminAgentTemplateItem = (
  row: PlatformAgentTemplateRecord,
): AdminAgentTemplateItem => ({
  avatar: row.avatar,
  backgroundColor: row.backgroundColor,
  description: row.description,
  enabled: row.enabled,
  id: row.id,
  identifier: row.identifier,
  revision: row.revision,
  sortOrder: row.sortOrder,
  source: row.source === 'builtin' ? 'builtin' : 'manual',
  systemRole: row.systemRole,
  tags: Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string') : [],
  title: row.title,
  updatedAt: row.updatedAt,
});

/**
 * Whether the user-side card could actually render this row.
 *
 * A row with an empty title or system role cannot prefill the create-agent input, so the
 * public read quarantines it (it stays visible and fixable in the admin console) instead of
 * shipping a blank card — or, worse, failing the whole managed catalog.
 */
export const isRenderableAgentTemplate = (row: PlatformAgentTemplateRecord): boolean =>
  row.title.trim().length > 0 && row.systemRole.trim().length > 0;

/** Row → user-facing template DTO (no admin bookkeeping fields). */
export const toPlatformAgentTemplate = (
  row: PlatformAgentTemplateRecord,
): PlatformAgentTemplate => ({
  avatar: row.avatar,
  backgroundColor: row.backgroundColor,
  description: row.description,
  id: row.id,
  identifier: row.identifier,
  systemRole: row.systemRole,
  tags: Array.isArray(row.tags) ? row.tags.filter((tag) => typeof tag === 'string') : [],
  title: row.title,
});

const AUDIT_TEXT_MAX = 120;

const truncate = (value: string) =>
  value.length > AUDIT_TEXT_MAX ? `${value.slice(0, AUDIT_TEXT_MAX)}…` : value;

/**
 * Bounded audit summary of an agent-template row.
 *
 * Records what an operator would need to reconstruct the change (identity, visibility,
 * ordering) while keeping the diff small: free-text bodies are represented by their
 * length, not their content, so a long system role cannot bloat every audit row.
 */
export const toAgentTemplateAuditDiff = (
  row: PlatformAgentTemplateRecord,
): Record<string, unknown> => ({
  descriptionLength: row.description.length,
  enabled: row.enabled,
  identifier: truncate(row.identifier),
  revision: row.revision,
  sortOrder: row.sortOrder,
  source: row.source,
  systemRoleLength: row.systemRole.length,
  tags: row.tags.slice(0, 10),
  title: truncate(row.title),
});

const RANDOM_SUFFIX_LENGTH = 6;

const randomSuffix = () =>
  Math.random()
    .toString(36)
    .slice(2, 2 + RANDOM_SUFFIX_LENGTH)
    .padEnd(RANDOM_SUFFIX_LENGTH, '0');

/**
 * Derive a slug from a manually authored title.
 *
 * The suffix is what makes two identically titled templates distinguishable, so the slug is
 * truncated first to leave room for it — appending before truncation would deterministically
 * collide every long title sharing a prefix. Non-ASCII titles (e.g. 中文) slugify to nothing,
 * so a `custom-<6 base36>` fallback keeps every row addressable by identifier.
 */
export const deriveAgentTemplateIdentifier = (title: string, suffix = randomSuffix()): string => {
  const maxSlug = AGENT_TEMPLATE_IDENTIFIER_MAX - suffix.length - 1;
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, Math.max(0, maxSlug))
    .replaceAll(/-+$/g, '');

  return slug ? `${slug}-${suffix}` : `custom-${suffix}`;
};

/** Upper bound on one import batch — the built-in set is 40; a guard, not a cap. */
export const AGENT_TEMPLATE_IMPORT_MAX_ROWS = 200;

/**
 * Resolve the built-in create-agent examples for 导入内置示例.
 *
 * The loader always yields 40 slots (`agent-01` … `agent-40`). Rows are then validated
 * **individually** against the local write contract: an empty title/prompt (missing locale
 * copy), an oversized field, or a duplicate identifier is counted as `skipped` instead of
 * failing the whole import.
 */
export const fetchBuiltInAgentTemplatesForImport = (params: {
  locale?: string;
}): { rows: PlatformAgentTemplateImportRow[]; skipped: number } => {
  const items = builtInAgentTemplatesForImport(params.locale);
  const rows: PlatformAgentTemplateImportRow[] = [];
  const seen = new Set<string>();
  const considered = items.slice(0, AGENT_TEMPLATE_IMPORT_MAX_ROWS);
  let skipped = items.length - considered.length;

  for (const item of considered) {
    const parsed = writableShape.safeParse({
      avatar: null,
      backgroundColor: null,
      description: item.description,
      enabled: true,
      systemRole: item.systemRole,
      tags: [],
      title: item.title,
    });
    if (!parsed.success || seen.has(item.identifier)) {
      skipped += 1;
      continue;
    }
    seen.add(item.identifier);
    rows.push({
      description: parsed.data.description,
      identifier: item.identifier,
      systemRole: parsed.data.systemRole,
      tags: parsed.data.tags,
      title: parsed.data.title,
    });
  }

  return { rows, skipped };
};

const matchesPreviewQuery = (haystacks: string[], query?: string): boolean => {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return haystacks.some((value) => value.toLowerCase().includes(needle));
};

/**
 * Read-only admin preview of the locale examples users currently see.
 *
 * Does **not** import: an empty table stays unmanaged (`platform.agentTemplates.list` keeps
 * serving `suggestQuestions`). Preview ids are `preview:<identifier>` so a mutation against
 * them misses the table and follows the existing NOT_FOUND path.
 */
export const listUnmanagedAgentTemplatePreview = (params: {
  enabled?: boolean;
  limit: number;
  locale?: string;
  offset: number;
  query?: string;
}): AdminAgentTemplateListOutput => {
  if (params.enabled === false) {
    return { items: [], origin: 'unmanaged', totalAll: 0, totalFiltered: 0 };
  }

  const matched = builtInAgentTemplatesForImport(params.locale)
    .map((row, sortOrder): AdminAgentTemplateItem => ({
      avatar: null,
      backgroundColor: null,
      description: row.description,
      enabled: true,
      id: `${AGENT_TEMPLATE_PREVIEW_ID_PREFIX}${row.identifier}`,
      identifier: row.identifier,
      revision: 0,
      sortOrder,
      source: 'builtin',
      systemRole: row.systemRole,
      tags: [],
      title: row.title,
      updatedAt: PREVIEW_UPDATED_AT,
    }))
    .filter((item) =>
      matchesPreviewQuery([item.title, item.identifier, item.description], params.query),
    );

  return {
    items: matched.slice(params.offset, params.offset + params.limit),
    origin: 'unmanaged',
    totalAll: 0,
    totalFiltered: matched.length,
  };
};
