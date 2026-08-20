import type { TaskTemplateCategory, TaskTemplateIcon } from '@lobechat/const';
import { INTEREST_AREA_KEYS, TASK_TEMPLATE_CATEGORIES, TASK_TEMPLATE_ICONS } from '@lobechat/const';

import type {
  PlatformTaskTemplateImportRow,
  PlatformTaskTemplateRecord,
} from '@/database/models/platform';
import { listTaskTemplateLibrary, TaskTemplateService } from '@/server/services/taskTemplate';

import type {
  AdminTaskTemplateConnector,
  AdminTaskTemplateItem,
  AdminTaskTemplateListOutput,
  PlatformTaskTemplate,
} from '../../contracts/adminTaskTemplates';
import {
  isKnownTaskTemplateConnector,
  TASK_TEMPLATE_IDENTIFIER_MAX,
  taskTemplateMarketImportRowSchema,
} from '../../contracts/adminTaskTemplates';

const CATEGORY_SET = new Set<string>(TASK_TEMPLATE_CATEGORIES);
const ICON_SET = new Set<string>(TASK_TEMPLATE_ICONS);
const INTEREST_SET = new Set<string>(INTEREST_AREA_KEYS);

/** Prefix for read-only preview ids synthesized from the bundled library. */
export const TASK_TEMPLATE_PREVIEW_ID_PREFIX = 'preview:';

/** Fixed timestamp so preview rows stay type-valid without pretending they were written. */
const PREVIEW_UPDATED_AT = new Date(0);

const isConnector = (value: unknown): value is AdminTaskTemplateConnector => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.identifier === 'string' &&
    typeof candidate.required === 'boolean' &&
    (candidate.source === 'composio' || candidate.source === 'lobehub')
  );
};

const normalizeConnectors = (value: unknown): AdminTaskTemplateConnector[] =>
  Array.isArray(value) ? value.filter((item) => isConnector(item)) : [];

const normalizeInterests = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * A stored row can outlive an enum entry (a category removed from the product, an old icon).
 * Admin rows keep a safe fallback rather than failing the whole list on one stale row.
 */
const safeCategory = (value: string): TaskTemplateCategory =>
  CATEGORY_SET.has(value) ? (value as TaskTemplateCategory) : 'operations';

const safeIcon = (value: string | null): TaskTemplateIcon | null =>
  value && ICON_SET.has(value) ? (value as TaskTemplateIcon) : null;

const safeInterests = (values: string[]) =>
  values.filter((value) => INTEREST_SET.has(value)) as PlatformTaskTemplate['interests'];

/** Row → admin console DTO. */
export const toAdminTaskTemplateItem = (
  row: PlatformTaskTemplateRecord,
): AdminTaskTemplateItem => ({
  category: safeCategory(row.category),
  connectors: normalizeConnectors(row.connectors),
  cronPattern: row.cronPattern,
  description: row.description,
  enabled: row.enabled,
  icon: safeIcon(row.icon),
  id: row.id,
  identifier: row.identifier,
  instruction: row.instruction,
  interests: safeInterests(normalizeInterests(row.interests)),
  revision: row.revision,
  sortOrder: row.sortOrder,
  source: row.source === 'market' ? 'market' : 'manual',
  title: row.title,
  updatedAt: row.updatedAt,
});

/**
 * Whether the user-side card could actually render this row.
 *
 * A connector whose provider has since been retired from the builtin catalogs has no icon, no
 * label and no OAuth flow, so the card would be dropped client-side anyway. The public read
 * quarantines such rows (they stay visible and fixable in the admin console) instead of shipping
 * a template that silently disappears — or, worse, failing the whole managed catalog.
 */
export const isRenderableTaskTemplate = (row: PlatformTaskTemplateRecord): boolean =>
  normalizeConnectors(row.connectors).every((connector) => isKnownTaskTemplateConnector(connector));

/** Row → user-facing template DTO (no admin bookkeeping fields). */
export const toPlatformTaskTemplate = (row: PlatformTaskTemplateRecord): PlatformTaskTemplate => {
  const icon = safeIcon(row.icon);
  return {
    category: safeCategory(row.category),
    connectors: normalizeConnectors(row.connectors),
    cronPattern: row.cronPattern,
    description: row.description,
    id: row.id,
    identifier: row.identifier,
    instruction: row.instruction,
    interests: safeInterests(normalizeInterests(row.interests)),
    title: row.title,
    ...(icon ? { icon } : {}),
  };
};

const AUDIT_TEXT_MAX = 120;

const truncate = (value: string) =>
  value.length > AUDIT_TEXT_MAX ? `${value.slice(0, AUDIT_TEXT_MAX)}…` : value;

/**
 * Bounded audit summary of a task-template row.
 *
 * Records what an operator would need to reconstruct the change (identity, schedule, visibility,
 * ordering, dependencies) while keeping the diff small: free-text bodies are represented by their
 * length, not their content, so an 8k instruction cannot bloat every audit row.
 */
export const toTaskTemplateAuditDiff = (
  row: PlatformTaskTemplateRecord,
): Record<string, unknown> => ({
  category: row.category,
  connectors: row.connectors
    .slice(0, 10)
    .map((connector) => `${connector.source}:${connector.identifier}`),
  cronPattern: truncate(row.cronPattern),
  descriptionLength: row.description.length,
  enabled: row.enabled,
  identifier: truncate(row.identifier),
  instructionLength: row.instruction.length,
  interests: row.interests.slice(0, INTEREST_AREA_KEYS.length),
  revision: row.revision,
  sortOrder: row.sortOrder,
  source: row.source,
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
export const deriveTaskTemplateIdentifier = (title: string, suffix = randomSuffix()): string => {
  const maxSlug = TASK_TEMPLATE_IDENTIFIER_MAX - suffix.length - 1;
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, Math.max(0, maxSlug))
    .replaceAll(/-+$/g, '');

  return slug ? `${slug}-${suffix}` : `custom-${suffix}`;
};

/** Upper bound on one import batch — the bundled library is far below it; a guard, not a cap. */
export const TASK_TEMPLATE_IMPORT_MAX_ROWS = 200;

/**
 * Pull the bundled task-template library for 从推荐库导入.
 *
 * Rows are validated **individually** against the local import contract: a row with an oversized
 * title, an unsupported cron, an unknown connector or a non-slug identifier is counted as
 * `skipped` instead of failing the whole import (and can never be persisted in a shape the admin
 * list's own output schema would later reject).
 */
export const fetchLibraryTaskTemplatesForImport = async (params: {
  locale?: string;
  userId: string;
}): Promise<{ rows: PlatformTaskTemplateImportRow[]; skipped: number }> => {
  const service = new TaskTemplateService(params.userId);
  const items = await service.listDailyRecommendRaw([...INTEREST_AREA_KEYS], {
    locale: params.locale,
  });

  const rows: PlatformTaskTemplateImportRow[] = [];
  const seen = new Set<string>();
  // Anything beyond the guard is reported, never silently dropped.
  const considered = items.slice(0, TASK_TEMPLATE_IMPORT_MAX_ROWS);
  let skipped = items.length - considered.length;

  for (const item of considered) {
    const parsed = taskTemplateMarketImportRowSchema.safeParse(item);
    // An identifier is the upsert key; a duplicate within one batch cannot be reconciled.
    if (!parsed.success || seen.has(parsed.data.identifier)) {
      skipped += 1;
      continue;
    }
    seen.add(parsed.data.identifier);
    rows.push({
      category: parsed.data.category,
      connectors: parsed.data.connectors,
      cronPattern: parsed.data.cronPattern,
      description: parsed.data.description,
      icon: parsed.data.icon,
      identifier: parsed.data.identifier,
      instruction: parsed.data.instruction,
      interests: [...parsed.data.interests],
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
 * Read-only admin preview of the bundled library users currently see.
 *
 * Does **not** import: an empty table stays unmanaged (`platform.taskTemplates.list` keeps
 * serving `listTaskTemplateLibrary`). Preview ids are `preview:<identifier>` so a mutation
 * against them misses the table and follows the existing NOT_FOUND path.
 */
export const listUnmanagedTaskTemplatePreview = (params: {
  enabled?: boolean;
  limit: number;
  locale?: string;
  offset: number;
  query?: string;
}): AdminTaskTemplateListOutput => {
  if (params.enabled === false) {
    return { items: [], origin: 'unmanaged', totalAll: 0, totalFiltered: 0 };
  }

  const matched = listTaskTemplateLibrary(params.locale)
    .map((row, sortOrder): AdminTaskTemplateItem => {
      const icon = safeIcon(row.icon ?? null);
      return {
        category: safeCategory(row.category),
        connectors: normalizeConnectors(row.connectors),
        cronPattern: row.cronPattern,
        description: row.description,
        enabled: true,
        icon,
        id: `${TASK_TEMPLATE_PREVIEW_ID_PREFIX}${row.identifier}`,
        identifier: row.identifier,
        instruction: row.instruction,
        interests: safeInterests(normalizeInterests(row.interests)),
        revision: 0,
        sortOrder,
        source: 'market',
        title: row.title,
        updatedAt: PREVIEW_UPDATED_AT,
      };
    })
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
