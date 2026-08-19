/**
 * Finite strict catalog for legacy `updateSettings` compatibility (M05 B4/R3-B4).
 * Reuses canonical AgentChatConfigSchema + LobeMetaDataSchema for released leaves.
 * Rejects unknown nested / secret-like fields with zero writes.
 */

import { AgentChatConfigSchema, LobeMetaDataSchema, ReasoningGraphSchema } from '@lobechat/types';
import { z } from 'zod';

import { SETTINGS_SECRET_PATH_PREFIXES, systemAgentReasoningEffortSchema } from './registry';

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
    // `.nullable().optional()`: omit (sparse) OR `null` (user-side explicit clear).
    // The settings merge drops `undefined`, so `null` is the persistable clear sentinel.
    reasoningEffort: systemAgentReasoningEffortSchema.nullable().optional(),
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

const llmParamsSchema = z
  .object({
    frequency_penalty: z.number().optional(),
    max_tokens: z.number().optional(),
    presence_penalty: z.number().optional(),
    reasoning_effort: z.string().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
  })
  .strict();

const strictGraphFieldRefSchema = z
  .object({
    desc: z.string().min(1).optional(),
    field: z.string().min(1),
    required: z.boolean().optional(),
  })
  .strict();

const strictGraphInputFieldSchema = strictGraphFieldRefSchema
  .extend({ from: z.string().min(1) })
  .strict();

const strictReasoningGraphSchema = z
  .object({
    description: z.string().optional(),
    edges: z.array(
      z
        .object({
          // Intentional JSON Schema record: arbitrary JSON-Schema keywords remain valid.
          condition: z.record(z.unknown()).optional(),
          from: z.string(),
          input: z
            .object({ fields: z.array(strictGraphInputFieldSchema).optional() })
            .strict()
            .optional(),
          instruction: z.string().min(1),
          maxTraversals: z.number().int().nonnegative().optional(),
          output: z
            .object({
              fields: z.array(strictGraphFieldRefSchema).optional(),
              instruction: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
          to: z.string(),
        })
        .strict(),
    ),
    fields: z.record(
      z
        .object({
          desc: z.string().min(1),
          // Intentional JSON Schema record: do not make schema keywords finite.
          schema: z.record(z.unknown()),
        })
        .strict(),
    ),
    maxInstructionCount: z.number().int().positive().optional(),
    name: z.string().min(1),
    nodes: z.record(
      z.discriminatedUnion('type', [
        z
          .object({
            allowedToolApiNames: z.array(z.string().min(1)).optional(),
            maxAgentSteps: z.number().int().positive().optional(),
            type: z.literal('agent'),
          })
          .strict(),
        z.object({ type: z.literal('llm') }).strict(),
      ]),
    ),
    terminal: z.string().min(1),
  })
  .strict()
  .pipe(ReasoningGraphSchema);

/**
 * The canonical schema owns the released leaf set. `partial()` is important:
 * it neutralizes canonical defaults so a sparse legacy patch stays sparse.
 * Nested object overrides make unknown keys fail recursively instead of being
 * silently stripped by Zod's default object behaviour.
 */
const strictAgentChatConfigSchema = AgentChatConfigSchema.partial()
  .strict()
  .extend({
    graph: strictReasoningGraphSchema.nullish(),
    memory: z
      .object({
        effort: memoryEffortSchema.optional(),
        enabled: z.boolean().optional(),
        toolPermission: z.enum(['read-only', 'read-write']).optional(),
      })
      .strict()
      .optional(),
    runtimeEnv: z.object({ workingDirectory: z.string().optional() }).strict().optional(),
    searchFCModel: z.object({ model: z.string(), provider: z.string() }).strict().optional(),
    selfIteration: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  });

const lobeAgentTtsSchema = z
  .object({
    showAllLocaleVoice: z.boolean().optional(),
    sttLocale: z.string().optional(),
    ttsService: z.literal('openai').optional(),
    voice: z.object({ openai: z.string().optional() }).strict().optional(),
  })
  .strict();

/** Canonical chatConfig + released config/meta leaves (R3-B4). */
const lobeAgentConfigSchema = z
  .object({
    avatar: z.string().optional(),
    backgroundColor: z.string().optional(),
    chatConfig: strictAgentChatConfigSchema.optional(),
    model: z.string().optional(),
    openingMessage: z.string().optional(),
    openingQuestions: z.array(z.string()).optional(),
    params: llmParamsSchema.optional(),
    plugins: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              identifier: z.string(),
              mode: z.enum(['pinned', 'auto', 'disabled']).optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    provider: z.string().optional(),
    systemRole: z.string().optional(),
    title: z.string().optional(),
    tts: lobeAgentTtsSchema.optional(),
    virtual: z.boolean().optional(),
  })
  .strict();

const defaultAgentSchema = z
  .object({
    config: lobeAgentConfigSchema.optional(),
    meta: LobeMetaDataSchema.strict().optional(),
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
