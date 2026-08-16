import type { TFunction } from 'i18next';

import type {
  ModerationCategory,
  ModerationCategoryAction,
  ModerationClassifierKind,
  ModerationDecisionSource,
  ModerationEffectiveAction,
  ModerationMode,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';

/**
 * Tag colour per effective action (design §6.2). `default` renders the neutral tag —
 * an allowed request is not a status worth colouring.
 */
export const EFFECTIVE_ACTION_TAG_COLOR: Record<ModerationEffectiveAction, string | undefined> = {
  allow: undefined,
  block: 'red',
  downgrade: 'orange',
  error: 'volcano',
  log: 'gold',
};

/**
 * Category display names are shared with the conversation UI, so they live in the
 * `common` namespace (design §3.6) — never duplicate them per surface.
 */
export const categoryLabel = (t: TFunction<'admin'>, category: string): string =>
  t(`moderation.category.${category}` as never, { defaultValue: category, ns: 'common' });

export const effectiveActionLabel = (
  t: TFunction<'admin'>,
  action: ModerationEffectiveAction | string,
): string => t(`contentModeration.action.${action}` as never, { defaultValue: action });

export const policyActionLabel = (
  t: TFunction<'admin'>,
  action: ModerationCategoryAction | string,
): string => t(`contentModeration.policyAction.${action}` as never, { defaultValue: action });

export const decisionSourceLabel = (
  t: TFunction<'admin'>,
  source: ModerationDecisionSource | string,
): string => t(`contentModeration.source.${source}` as never, { defaultValue: source });

export const requestKindLabel = (
  t: TFunction<'admin'>,
  kind: ModerationRequestKind | string,
): string => t(`contentModeration.requestKind.${kind}` as never, { defaultValue: kind });

export const modeLabel = (t: TFunction<'admin'>, mode: ModerationMode | string): string =>
  t(`contentModeration.mode.${mode}` as never, { defaultValue: mode });

export const classifierKindLabel = (
  t: TFunction<'admin'>,
  kind: ModerationClassifierKind | string,
): string => t(`contentModeration.classifierKind.${kind}` as never, { defaultValue: kind });

/** `0.8213` → `0.82`; nullish → em dash. */
export const formatScore = (score: number | null | undefined): string =>
  typeof score === 'number' && Number.isFinite(score) ? score.toFixed(2) : '—';

/** Millisecond durations stay in ms below a second, then switch to one decimal second. */
export const formatLatency = (ms: number | null | undefined): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
};

/** `openai / gpt-4o-mini` → the pair the record columns show as `原 → 实际`. */
export const formatModelPair = (provider: string | null, model: string | null): string => {
  if (!provider && !model) return '—';
  return [provider, model].filter(Boolean).join(' / ');
};

export type ClassifierHealthLevel = 'disabled' | 'error' | 'healthy' | 'unknown' | 'unstable';

/**
 * Classifier health pill (design §6.1): 正常 / 波动 / 异常 / 未启用. A configured classifier
 * that has not run yet is "unknown" — reporting 正常 on zero samples would be a lie.
 */
export const classifierHealthLevel = (
  kind: ModerationClassifierKind,
  health: { sampleSize: number; successRate: number } | null | undefined,
): ClassifierHealthLevel => {
  if (kind === 'none') return 'disabled';
  if (!health || health.sampleSize === 0) return 'unknown';
  if (health.successRate >= 0.95) return 'healthy';
  if (health.successRate >= 0.8) return 'unstable';
  return 'error';
};

export const CLASSIFIER_HEALTH_TAG_COLOR: Record<ClassifierHealthLevel, string | undefined> = {
  disabled: undefined,
  error: 'red',
  healthy: 'success',
  unknown: undefined,
  unstable: 'warning',
};

/** Percentage with no decimals; `null` when there is nothing to report. */
export const formatPercent = (rate: number | null | undefined): string =>
  typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';

export const displayModerationUser = (
  snapshot: { email?: string | null; fullName?: string | null; username?: string | null } | null,
  userId: string | null,
): string =>
  snapshot?.fullName?.trim() ||
  snapshot?.username?.trim() ||
  snapshot?.email?.trim() ||
  userId ||
  '—';

/** Category rows sorted by score (desc) so the reason for a decision reads first. */
export const sortCategoriesByScore = <T extends { score: number }>(rows: T[]): T[] =>
  [...rows].sort((left, right) => right.score - left.score);

/** Build the score-vs-threshold rows the drawer and the test panel both render. */
export const buildCategoryRows = (
  categories: readonly ModerationCategory[],
  scores: Partial<Record<string, number>> | null | undefined,
  thresholds:
    | Partial<Record<string, { action: ModerationCategoryAction; threshold: number }>>
    | null
    | undefined,
): {
  action?: ModerationCategoryAction;
  category: ModerationCategory;
  hit: boolean;
  score: number;
  threshold?: number;
}[] =>
  categories.map((category) => {
    const score = Number(scores?.[category] ?? 0);
    const policy = thresholds?.[category];
    return {
      action: policy?.action,
      category,
      hit: policy ? score >= policy.threshold : false,
      score: Number.isFinite(score) ? score : 0,
      threshold: policy?.threshold,
    };
  });

/**
 * Client mirror of the server's `normalizeModerationBaseUrl` (contentModerationSupport.ts).
 * Used to decide whether stored API keys survive an endpoint edit — the comparison has to
 * agree with the server, or the UI would promise a save the router then rejects.
 */
export const normalizeModerationBaseUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? `:${parsed.port}` : '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${protocol}//${hostname}${port}${pathname}${parsed.search}`;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
};

/**
 * True when the endpoint on screen no longer matches the one the stored keys were saved
 * against. The server refuses to reuse them (`endpoint_changed_reenter_keys`), so the UI must
 * drop them from `keep` and say so instead of letting the save fail.
 */
export const moderationEndpointChanged = (
  persistedBaseUrl: string | undefined,
  submittedBaseUrl: string | undefined,
): boolean => {
  if (!submittedBaseUrl) return false;
  if (!persistedBaseUrl) return true;
  return (
    normalizeModerationBaseUrl(persistedBaseUrl) !== normalizeModerationBaseUrl(submittedBaseUrl)
  );
};
