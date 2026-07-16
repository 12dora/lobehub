/**
 * Finite strict catalog for legacy `updateSettings` compatibility (M05 B4).
 * Rejects unknown nested / secret-like fields with zero writes.
 * Preserves known-but-not-platform-managed leaves (e.g. hotkey).
 */

import { z } from 'zod';

import { SETTINGS_SECRET_PATH_PREFIXES } from './registry';

const animationModeSchema = z.enum(['disabled', 'agile', 'elegant']);
const transitionModeSchema = z.enum(['smooth', 'fadeIn', 'none']);
const memoryEffortSchema = z.enum(['high', 'low', 'medium']);
const approvalModeSchema = z.enum(['auto-run', 'allow-list', 'manual', 'headless']);
const sttServerSchema = z.enum(['openai', 'browser']);

/** Secret-like key names forbidden anywhere in nested legacy payloads. */
const SECRET_KEY_RE =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key|client[_-]?secret|keyVaults)$/i;

const forbidSecretKeys = (value: unknown, path: string[]): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      return [...path, k].join('.');
    }
    const nested = forbidSecretKeys(v, [...path, k]);
    if (nested) return nested;
  }
  return null;
};

const generalSchema = z
  .object({
    animationMode: animationModeSchema.optional(),
    contextMenuMode: z.enum(['disabled', 'default']).optional(),
    costEstimateWarningThreshold: z.number().optional(),
    enableAutoScrollOnStreaming: z.boolean().optional(),
    enableMessageLinkIcon: z.boolean().optional(),
    fontSize: z.number().optional(),
    highlighterTheme: z.string().optional(),
    isDevMode: z.boolean().optional(),
    isLiteMode: z.boolean().optional(),
    mermaidTheme: z.string().optional(),
    neutralColor: z.string().optional(),
    primaryColor: z.string().optional(),
    responseLanguage: z.string().optional(),
    telemetry: z.boolean().optional(),
    timezone: z.string().optional(),
    transitionMode: transitionModeSchema.optional(),
  })
  .strict();

const memorySchema = z
  .object({
    effort: memoryEffortSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const toolSchema = z
  .object({
    humanIntervention: z
      .object({
        allowList: z.array(z.string()).optional(),
        approvalMode: approvalModeSchema.optional(),
      })
      .strict()
      .optional(),
    uninstalledBuiltinTools: z.array(z.string()).optional(),
    uninstalledBuiltinToolsByWorkspace: z.record(z.array(z.string())).optional(),
  })
  .strict();

const imageSchema = z
  .object({
    defaultImageNum: z.number().int().optional(),
  })
  .strict();

const ttsSchema = z
  .object({
    openAI: z
      .object({
        sttModel: z.literal('whisper-1').optional(),
        ttsModel: z.enum(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']).optional(),
      })
      .strict()
      .optional(),
    sttAutoStop: z.boolean().optional(),
    sttServer: sttServerSchema.optional(),
  })
  .strict();

const notificationChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    items: z.record(z.record(z.boolean())).optional(),
  })
  .strict();

const notificationSchema = z
  .object({
    email: notificationChannelSchema.optional(),
    inbox: notificationChannelSchema.optional(),
    push: notificationChannelSchema.optional(),
  })
  .strict();

const systemAgentItemSchema = z
  .object({
    contextLimit: z.number().optional(),
    customPrompt: z.string().optional(),
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  })
  .strict();

const systemAgentSchema = z
  .object({
    agentMeta: systemAgentItemSchema.optional(),
    followUpAction: systemAgentItemSchema.optional(),
    generationTopic: systemAgentItemSchema.optional(),
    historyCompress: systemAgentItemSchema.optional(),
    inputCompletion: systemAgentItemSchema.optional(),
    memoryAnalysisAgentConfig: systemAgentItemSchema.optional(),
    promptRewrite: systemAgentItemSchema.optional(),
    thread: systemAgentItemSchema.optional(),
    topic: systemAgentItemSchema.optional(),
    translation: systemAgentItemSchema.optional(),
    userMemoryEmbedding: systemAgentItemSchema.optional(),
    userMemoryPersonaWriter: systemAgentItemSchema.optional(),
  })
  .strict();

/** Finite strict LobeAgent chatConfig leaves (sparse patch). */
const lobeAgentChatConfigSchema = z
  .object({
    enableAgentMode: z.boolean().optional(),
    enableCompressHistory: z.boolean().optional(),
    enableContextCompression: z.boolean().optional(),
    enableFollowUpChips: z.boolean().optional(),
    enableHistoryCount: z.boolean().optional(),
    enableStreaming: z.boolean().optional(),
    historyCount: z.number().optional(),
    reasoningBudgetToken: z.number().optional(),
    searchMode: z.string().optional(),
  })
  .strict();

const llmParamsSchema = z
  .object({
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
  })
  .strict();

const lobeAgentTtsSchema = z
  .object({
    showAllLocaleVoice: z.boolean().optional(),
    sttLocale: z.string().optional(),
    ttsService: z.string().optional(),
    voice: z.record(z.string()).optional(),
  })
  .strict();

/** Finite strict LobeAgentConfig leaves — no z.record(z.unknown()) passthrough (B4-R2). */
const lobeAgentConfigSchema = z
  .object({
    avatar: z.string().optional(),
    backgroundColor: z.string().optional(),
    chatConfig: lobeAgentChatConfigSchema.optional(),
    model: z.string().optional(),
    openingMessage: z.string().optional(),
    openingQuestions: z.array(z.string()).optional(),
    params: llmParamsSchema.optional(),
    plugins: z
      .array(z.union([z.string(), z.record(z.union([z.string(), z.boolean()]))]))
      .optional(),
    provider: z.string().optional(),
    systemRole: z.string().optional(),
    title: z.string().optional(),
    tts: lobeAgentTtsSchema.optional(),
    virtual: z.boolean().optional(),
  })
  .strict();

/** Finite MetaData leaves. */
const metaDataSchema = z
  .object({
    avatar: z.string().optional(),
    backgroundColor: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    title: z.string().optional(),
  })
  .strict();

const defaultAgentSchema = z
  .object({
    config: lobeAgentConfigSchema.optional(),
    meta: metaDataSchema.optional(),
  })
  .strict();

/**
 * Strict partial update for user settings.
 * - `.strict()` at top level and nested known groups
 * - hotkey preserved as string map (not platform-managed)
 * - keyVaults allowed only as opaque object (encrypted separately; never into overrides)
 * - languageModel / market rejected as secret-like platform-ineligible roots
 */
export const strictLegacySettingsUpdateSchema = z
  .object({
    defaultAgent: defaultAgentSchema.optional(),
    general: generalSchema.optional(),
    hotkey: z.record(z.string()).optional(),
    image: imageSchema.optional(),
    keyVaults: z.record(z.unknown()).optional(),
    memory: memorySchema.optional(),
    notification: notificationSchema.optional(),
    systemAgent: systemAgentSchema.optional(),
    tool: toolSchema.optional(),
    tts: ttsSchema.optional(),
  })
  .strict();

export type StrictLegacySettingsUpdate = z.infer<typeof strictLegacySettingsUpdateSchema>;

export type LegacySettingsCatalogError = {
  code:
    | 'MANAGED_SETTING_UNKNOWN_PATH'
    | 'MANAGED_SETTING_SECRET_PATH'
    | 'MANAGED_SETTING_INVALID_VALUE';
  message: string;
  path: string;
};

/**
 * Validate legacy update payload. Fail-closed on unknown/secret fields.
 */
export const validateLegacySettingsUpdate = (
  input: unknown,
):
  | { ok: true; value: StrictLegacySettingsUpdate }
  | { ok: false; error: LegacySettingsCatalogError } => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: 'MANAGED_SETTING_INVALID_VALUE',
        message: 'Settings payload must be an object',
        path: '',
      },
    };
  }

  const obj = input as Record<string, unknown>;

  // Explicit secret roots
  for (const prefix of SETTINGS_SECRET_PATH_PREFIXES) {
    if (prefix in obj && prefix !== 'keyVaults') {
      // languageModel / market never accepted via updateSettings under policy
      return {
        ok: false,
        error: {
          code: 'MANAGED_SETTING_SECRET_PATH',
          message: `Secret or credential path not allowed: ${prefix}`,
          path: prefix,
        },
      };
    }
  }

  const secretHit = forbidSecretKeys(obj, []);
  if (secretHit && !secretHit.startsWith('keyVaults')) {
    return {
      ok: false,
      error: {
        code: 'MANAGED_SETTING_SECRET_PATH',
        message: `Secret-like field not allowed: ${secretHit}`,
        path: secretHit,
      },
    };
  }

  const parsed = strictLegacySettingsUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    const isUnknown =
      issue?.code === 'unrecognized_keys' ||
      String(issue?.message ?? '')
        .toLowerCase()
        .includes('unrecognized');
    return {
      ok: false,
      error: {
        code: isUnknown ? 'MANAGED_SETTING_UNKNOWN_PATH' : 'MANAGED_SETTING_INVALID_VALUE',
        message: issue?.message ?? 'Invalid settings',
        path,
      },
    };
  }

  return { ok: true, value: parsed.data };
};
