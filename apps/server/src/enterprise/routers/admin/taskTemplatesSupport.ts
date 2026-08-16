import type { TaskTemplateCategory, TaskTemplateIcon } from '@lobechat/const';
import {
  INTEREST_AREA_KEYS,
  TASK_TEMPLATE_CATEGORIES,
  TASK_TEMPLATE_ICONS,
  TASK_TEMPLATE_RECOMMEND_MAX_COUNT,
} from '@lobechat/const';

import type {
  PlatformTaskTemplateImportRow,
  PlatformTaskTemplateRecord,
} from '@/database/models/platform';
import { TaskTemplateService } from '@/server/services/taskTemplate';

import type {
  AdminTaskTemplateConnector,
  AdminTaskTemplateItem,
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

/** Bounded deadline for the admin import's outbound market call. */
export const TASK_TEMPLATE_IMPORT_TIMEOUT_MS = 15_000;

/**
 * Pull the current market recommendations for 从推荐库导入.
 *
 * Rows are validated **individually** against the local import contract: an upstream row with an
 * oversized title, an unsupported cron, an unknown connector or a non-slug identifier is counted
 * as `skipped` instead of failing the whole import (and, crucially, can never be persisted in a
 * shape the admin list's own output schema would later reject).
 *
 * The batch is also capped locally at {@link TASK_TEMPLATE_RECOMMEND_MAX_COUNT}: `count` is only
 * a request parameter, so a malformed or hostile upstream could otherwise hand back an unbounded
 * array and turn one import into an unbounded transaction and audit record.
 */
export const fetchMarketTaskTemplatesForImport = async (params: {
  locale?: string;
  signal?: AbortSignal;
  userId: string;
}): Promise<{ rows: PlatformTaskTemplateImportRow[]; skipped: number }> => {
  const service = new TaskTemplateService(params.userId);
  const items = await service.listDailyRecommendRaw([...INTEREST_AREA_KEYS], {
    // Import wants the whole recommendable set, not a daily slice.
    count: TASK_TEMPLATE_RECOMMEND_MAX_COUNT,
    locale: params.locale,
    signal: params.signal ?? AbortSignal.timeout(TASK_TEMPLATE_IMPORT_TIMEOUT_MS),
  });

  const rows: PlatformTaskTemplateImportRow[] = [];
  const seen = new Set<string>();
  // Anything the upstream returned beyond our own cap is reported, never silently dropped.
  const considered = items.slice(0, TASK_TEMPLATE_RECOMMEND_MAX_COUNT);
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
