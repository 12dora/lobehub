import { MODERATION_CATEGORIES, type ModerationCategory } from '@/const/platform/contentModeration';

/**
 * Loose `t` shape — the category key is resolved dynamically, so the type-safe key inference in
 * `i18next.CustomTypeOptions` cannot help here (same trade-off as `runtimeErrorMessage`).
 */
type LooseT = (key: string, vars?: Record<string, unknown>) => string;

const KNOWN_CATEGORIES = new Set<string>(MODERATION_CATEGORIES);

/**
 * Narrow an untrusted category value (error body / persisted message metadata) to a category the
 * UI has copy for. Unknown values return `undefined` so the surface hides the line instead of
 * rendering a raw key — a newer server may know categories this client build does not.
 */
export const resolveModerationCategory = (value: unknown): ModerationCategory | undefined =>
  typeof value === 'string' && KNOWN_CATEGORIES.has(value)
    ? (value as ModerationCategory)
    : undefined;

/** i18n key of a category display name, shared by the chat surfaces and the admin console. */
export const moderationCategoryKey = (category: ModerationCategory): string =>
  `moderation.category.${category}`;

/**
 * `命中类别：<name>` line shown under a block card / behind the downgrade notice tooltip.
 * Returns `undefined` when the category is absent or unknown to this build.
 *
 * The caller must have the `common` namespace loaded (`useTranslation([..., 'common'])`).
 */
export const getModerationCategoryLabel = (t: unknown, category: unknown): string | undefined => {
  const resolved = resolveModerationCategory(category);
  if (!resolved) return undefined;

  const translate = t as LooseT;

  return translate('moderation.categoryLabel', {
    category: translate(moderationCategoryKey(resolved), { ns: 'common' }),
    ns: 'common',
  });
};
