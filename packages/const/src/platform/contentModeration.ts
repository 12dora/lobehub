/**
 * 内容审计 (content moderation) — shared vocabulary between the server runtime, the admin
 * panel and the conversation UI. Design: docs/enterprise/content-moderation.md.
 *
 * Keys are stable identifiers (persisted in DB rows and settings JSON); display names live in
 * i18n (`common:moderation.category.*`, shared by the chat UI and the admin panel).
 */

export const MODERATION_MODES = ['off', 'observe', 'enforce'] as const;
export type ModerationMode = (typeof MODERATION_MODES)[number];

export const MODERATION_CATEGORIES = [
  'sexual',
  'sexual_minors',
  'violence',
  'hate_harassment',
  'self_harm',
  'illicit',
  'political',
  'jailbreak',
  'privacy',
  'other',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

/** Policy-level action configured per category / keyword rule. Ordered from lenient to strict. */
export const MODERATION_CATEGORY_ACTIONS = ['ignore', 'log', 'downgrade', 'block'] as const;
export type ModerationCategoryAction = (typeof MODERATION_CATEGORY_ACTIONS)[number];

/** Runtime-level outcome persisted on a record. */
export const MODERATION_EFFECTIVE_ACTIONS = [
  'allow',
  'log',
  'downgrade',
  'block',
  'error',
] as const;
export type ModerationEffectiveAction = (typeof MODERATION_EFFECTIVE_ACTIONS)[number];

export const MODERATION_DECISION_SOURCES = [
  'keyword',
  'cache',
  'llm_judge',
  'moderations_api',
  'none',
] as const;
export type ModerationDecisionSource = (typeof MODERATION_DECISION_SOURCES)[number];

export const MODERATION_REQUEST_KINDS = ['chat', 'image', 'video'] as const;
export type ModerationRequestKind = (typeof MODERATION_REQUEST_KINDS)[number];

export const MODERATION_CLASSIFIER_KINDS = ['none', 'llm_judge', 'moderations_api'] as const;
export type ModerationClassifierKind = (typeof MODERATION_CLASSIFIER_KINDS)[number];

export const MODERATION_ACTION_SEVERITY: Record<ModerationCategoryAction, number> = {
  block: 3,
  downgrade: 2,
  ignore: 0,
  log: 1,
};

/** Default per-category policy (see design §3.3). */
export const MODERATION_DEFAULT_CATEGORY_POLICY: Record<
  ModerationCategory,
  { action: ModerationCategoryAction; threshold: number }
> = {
  hate_harassment: { action: 'log', threshold: 0.8 },
  illicit: { action: 'block', threshold: 0.9 },
  jailbreak: { action: 'downgrade', threshold: 0.75 },
  other: { action: 'ignore', threshold: 0.95 },
  political: { action: 'block', threshold: 0.7 },
  privacy: { action: 'log', threshold: 0.8 },
  self_harm: { action: 'block', threshold: 0.65 },
  sexual: { action: 'block', threshold: 0.65 },
  sexual_minors: { action: 'block', threshold: 0.5 },
  violence: { action: 'log', threshold: 0.9 },
};

/** OpenAI `/v1/moderations` category → platform category (max score wins per target). */
export const OPENAI_MODERATION_CATEGORY_MAP: Record<string, ModerationCategory> = {
  'harassment': 'hate_harassment',
  'harassment/threatening': 'hate_harassment',
  'hate': 'hate_harassment',
  'hate/threatening': 'hate_harassment',
  'illicit': 'illicit',
  'illicit/violent': 'illicit',
  'self-harm': 'self_harm',
  'self-harm/instructions': 'self_harm',
  'self-harm/intent': 'self_harm',
  'sexual': 'sexual',
  'sexual/minors': 'sexual_minors',
  'violence': 'violence',
  'violence/graphic': 'violence',
};

/** Hard limits enforced by settings validation. */
export const MODERATION_LIMITS = {
  KEYWORD_MAX_LENGTH: 200,
  KEYWORD_MAX_RULES: 10_000,
  /** Classifier input is truncated to this many characters (design §3.2). */
  CLASSIFIER_INPUT_MAX_CHARS: 4000,
  CLASSIFIER_TIMEOUT_MAX_MS: 30_000,
  CLASSIFIER_RETRY_MAX: 5,
  DECISION_CACHE_TTL_MAX_HOURS: 24 * 30,
  /** Extracted prompt text is normalised then capped before hashing / matching. */
  EXTRACT_MAX_CHARS: 12_000,
  HIT_RETENTION_MAX_DAYS: 3650,
  NON_HIT_RETENTION_MAX_DAYS: 3,
  PROMPT_EXCERPT_MAX_CHARS: 500,
  RECORDS_DELETE_MAX: 200,
} as const;

export const MODERATION_DEFAULTS = {
  AUTO_BAN_THRESHOLD: 10,
  AUTO_BAN_WINDOW_DAYS: 30,
  CLASSIFIER_RETRY_COUNT: 1,
  CLASSIFIER_TIMEOUT_MS: 3000,
  DECISION_CACHE_TTL_HOURS: 24,
  HIT_RETENTION_DAYS: 180,
  NON_HIT_RETENTION_DAYS: 3,
  SAMPLE_RATE: 100,
} as const;

/**
 * Response headers set by the runtime when a chat request was DOWNGRADED. The client (fetchSSE
 * onFinish) copies them into the assistant message metadata so the notice survives reloads.
 */
export const MODERATION_HEADERS = {
  ACTION: 'x-lobe-moderation',
  CATEGORY: 'x-lobe-moderation-category',
  /** Admin-configured downgrade notice override, `encodeURIComponent`-encoded (headers are ASCII). */
  MESSAGE: 'x-lobe-moderation-message',
  MODEL: 'x-lobe-moderation-model',
  PROVIDER: 'x-lobe-moderation-provider',
  RECORD: 'x-lobe-moderation-record',
} as const;

/** Value of `MODERATION_HEADERS.ACTION` when the request was downgraded. */
export const MODERATION_HEADER_ACTION_DOWNGRADE = 'downgrade';
