/**
 * Finite server-owned settings registry (M05).
 *
 * Only non-secret UserSettings leaf paths are eligible.
 * Explicitly excluded: keyVaults, market tokens, languageModel provider credentials,
 * and any secret-like path.
 */

import {
  DEFAULT_AGENT,
  DEFAULT_COMMON_SETTINGS,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_SYSTEM_AGENT_CONFIG,
  DEFAULT_TTS_CONFIG,
} from '@lobechat/const';
import type { EffortLevel } from '@lobechat/model-runtime';
import { EFFORT_CONTROL_KEYS, EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';
import type { SystemAgentReasoningEffort } from '@lobechat/types';
import { z } from 'zod';

import type {
  SettingClientSurface,
  SettingDefinition,
  SettingGroupId,
} from '@/types/platform/settings';

/** Bump when registered paths / schemas change in a breaking way for cache keys. */
export const SETTINGS_REGISTRY_VERSION = 5;

/** Appearance / preference leaves used only in user UI clients (B6-R2). */
const UI_CLIENTS: readonly SettingClientSurface[] = ['web', 'desktop', 'mobile'];
/** Runtime-consumed model/agent/memory leaves (server + interactive clients). */
const RUNTIME_CLIENTS: readonly SettingClientSurface[] = ['web', 'desktop', 'mobile', 'server'];

const animationModeSchema = z.enum(['disabled', 'agile', 'elegant']);
const transitionModeSchema = z.enum(['smooth', 'fadeIn', 'none']);
const memoryEffortSchema = z.enum(['high', 'low', 'medium']);
const approvalModeSchema = z.enum(['auto-run', 'allow-list', 'manual', 'headless']);
const sttServerSchema = z.enum(['openai', 'browser']);
const sttModelSchema = z.literal('whisper-1');
const ttsModelSchema = z.enum(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
/**
 * Canonical discrete levels for `SystemAgentItem.reasoningEffort`.
 * Shared with `legacySettingsCatalog` so both gates cannot drift.
 */
export const SYSTEM_AGENT_REASONING_EFFORT_LEVELS = [
  'no_think',
  'disabled',
  'none',
  'minimal',
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'enabled',
] as const satisfies readonly SystemAgentReasoningEffort[];

type _MissingSystemAgentReasoningEffort = Exclude<
  SystemAgentReasoningEffort,
  (typeof SYSTEM_AGENT_REASONING_EFFORT_LEVELS)[number]
>;
const _assertAllSystemAgentReasoningEffortLevels: _MissingSystemAgentReasoningEffort extends never
  ? true
  : never = true;
void _assertAllSystemAgentReasoningEffortLevels;

export const systemAgentReasoningEffortSchema = z.enum(SYSTEM_AGENT_REASONING_EFFORT_LEVELS);
const SYSTEM_AGENT_REASONING_EFFORT_KEYS = [
  'topic',
  'generationTopic',
  'translation',
  'historyCompress',
  'agentMeta',
  'followUpAction',
  'inputCompletion',
  'promptRewrite',
  'memoryAnalysisAgentConfig',
  'userMemoryPersonaWriter',
] as const;
const SYSTEM_AGENT_REASONING_EFFORT_OPTIONS = SYSTEM_AGENT_REASONING_EFFORT_LEVELS.map((value) => ({
  labelKey: `settingsPolicy.options.systemAgent.reasoningEffort.${value}`,
  value,
}));

/** Per-key enum — not the full EffortLevel union, not nullable. */
const effortLevelSchema = (levels: readonly EffortLevel[]) => {
  const [first, ...rest] = levels;
  if (!first) throw new Error('Effort control levels must be non-empty');
  return z.enum([first, ...rest]);
};

const effortSelectOptions = (levels: readonly EffortLevel[]) =>
  levels.map((value) => ({
    labelKey: `settingsPolicy.options.systemAgent.reasoningEffort.${value}`,
    value,
  }));

/**
 * One primitive leaf per EffortControlKey. Path strings stay discoverable for tests
 * even though the registry entries themselves are generated from the model-runtime table.
 */
export const DEFAULT_AGENT_CHAT_CONFIG_EFFORT_PATHS = EFFORT_CONTROL_KEYS.map(
  (key) => `defaultAgent.config.chatConfig.${key}`,
);

type Def = SettingDefinition;

/**
 * `builtInDefault` is optional so a leaf can stay absent until a policy (or user
 * override) exists. The resolver skips `undefined` effective values (`setByPath`).
 */
type RegistryEntry<T> = Omit<SettingDefinition<T>, 'builtInDefault'> & {
  builtInDefault?: T;
};

const def = <T>(entry: RegistryEntry<T>): Def => entry as Def;

/**
 * Ordered registry entries. Keep leaf paths only; no secret / credential paths.
 */
const REGISTRY_ENTRIES: readonly Def[] = [
  // ── general ──────────────────────────────────────────────
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_COMMON_SETTINGS.fontSize,
    control: 'number',
    descriptionKey: 'settingsPolicy.paths.general.fontSize.desc',
    group: 'general',
    max: 24,
    min: 12,
    path: 'general.fontSize',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
    },
    platformPolicyEligible: true,
    schema: z.number().int().min(12).max(24),
    schemaVersion: 1,
    sensitivity: 'public',
    step: 1,
    titleKey: 'settingsPolicy.paths.general.fontSize.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_COMMON_SETTINGS.animationMode ?? 'agile',
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.general.animationMode.desc',
    group: 'general',
    options: [
      { labelKey: 'settingsPolicy.options.animation.disabled', value: 'disabled' },
      { labelKey: 'settingsPolicy.options.animation.agile', value: 'agile' },
      { labelKey: 'settingsPolicy.options.animation.elegant', value: 'elegant' },
    ],
    path: 'general.animationMode',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/common/features/Common/Common.tsx',
    },
    platformPolicyEligible: true,
    schema: animationModeSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.animationMode.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_COMMON_SETTINGS.telemetry,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.general.telemetry.desc',
    group: 'general',
    path: 'general.telemetry',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/about/features/Analytics.tsx',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.telemetry.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_COMMON_SETTINGS.isLiteMode,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.general.isLiteMode.desc',
    group: 'general',
    path: 'general.isLiteMode',
    userControlSurface: { kind: 'none', reason: 'No dedicated settings control in main SPA' },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.isLiteMode.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_COMMON_SETTINGS.transitionMode ?? 'fadeIn',
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.general.transitionMode.desc',
    group: 'general',
    options: [
      { labelKey: 'settingsPolicy.options.transition.smooth', value: 'smooth' },
      { labelKey: 'settingsPolicy.options.transition.fadeIn', value: 'fadeIn' },
      { labelKey: 'settingsPolicy.options.transition.none', value: 'none' },
    ],
    path: 'general.transitionMode',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
    },
    platformPolicyEligible: true,
    schema: transitionModeSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.transitionMode.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_COMMON_SETTINGS.costEstimateWarningThreshold ?? 2,
    control: 'number',
    descriptionKey: 'settingsPolicy.paths.general.costEstimateWarningThreshold.desc',
    group: 'general',
    max: 100,
    min: 0,
    path: 'general.costEstimateWarningThreshold',
    userControlSurface: { kind: 'none', reason: 'No dedicated settings control in main SPA' },
    platformPolicyEligible: true,
    schema: z.number().min(0).max(100),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.costEstimateWarningThreshold.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.general.enableAutoScrollOnStreaming.desc',
    group: 'general',
    path: 'general.enableAutoScrollOnStreaming',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.enableAutoScrollOnStreaming.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.general.enableMessageLinkIcon.desc',
    group: 'general',
    path: 'general.enableMessageLinkIcon',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.general.enableMessageLinkIcon.title',
  }),
  // responseLanguage / timezone intentionally omitted: no schema-valid built-in default
  // and optional absence is not modeled as a forced string leaf.

  // ── memory ───────────────────────────────────────────────
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_MEMORY_SETTINGS.enabled ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.memory.enabled.desc',
    group: 'memory',
    path: 'memory.enabled',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.memory.enabled.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_MEMORY_SETTINGS.effort ?? 'medium',
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.memory.effort.desc',
    group: 'memory',
    options: [
      { labelKey: 'settingsPolicy.options.memory.effort.low', value: 'low' },
      { labelKey: 'settingsPolicy.options.memory.effort.medium', value: 'medium' },
      { labelKey: 'settingsPolicy.options.memory.effort.high', value: 'high' },
    ],
    path: 'memory.effort',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
    },
    platformPolicyEligible: true,
    schema: memoryEffortSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.memory.effort.title',
  }),

  // ── tool ─────────────────────────────────────────────────
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: 'manual' as const,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tool.humanIntervention.approvalMode.desc',
    group: 'tool',
    options: [
      { labelKey: 'settingsPolicy.options.approval.autoRun', value: 'auto-run' },
      { labelKey: 'settingsPolicy.options.approval.allowList', value: 'allow-list' },
      { labelKey: 'settingsPolicy.options.approval.manual', value: 'manual' },
      { labelKey: 'settingsPolicy.options.approval.headless', value: 'headless' },
    ],
    path: 'tool.humanIntervention.approvalMode',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/features/ChatInput/ControlBar/ApprovalMode.tsx',
    },
    platformPolicyEligible: true,
    schema: approvalModeSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tool.humanIntervention.approvalMode.title',
  }),

  // ── image ────────────────────────────────────────────────
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_IMAGE_CONFIG.defaultImageNum,
    control: 'number',
    descriptionKey: 'settingsPolicy.paths.image.defaultImageNum.desc',
    group: 'image',
    max: 20,
    min: 1,
    path: 'image.defaultImageNum',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/image/features/Image.tsx',
    },
    platformPolicyEligible: true,
    schema: z.number().int().min(1).max(20),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.image.defaultImageNum.title',
  }),

  // ── tts ──────────────────────────────────────────────────
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.sttAutoStop,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.tts.sttAutoStop.desc',
    group: 'tts',
    path: 'tts.sttAutoStop',
    userControlSurface: {
      kind: 'none',
      reason: 'No ordinary-user control; TTS settings expose only the OpenAI TTS model',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.sttAutoStop.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.sttServer,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tts.sttServer.desc',
    group: 'tts',
    options: [
      { labelKey: 'settingsPolicy.options.tts.sttServer.openai', value: 'openai' },
      { labelKey: 'settingsPolicy.options.tts.sttServer.browser', value: 'browser' },
    ],
    path: 'tts.sttServer',
    userControlSurface: {
      kind: 'none',
      reason: 'No ordinary-user control; TTS settings expose only the OpenAI TTS model',
    },
    platformPolicyEligible: true,
    schema: sttServerSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.sttServer.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.openAI.sttModel,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tts.openAI.sttModel.desc',
    group: 'tts',
    options: [{ labelKey: 'settingsPolicy.options.tts.sttModel.whisper1', value: 'whisper-1' }],
    path: 'tts.openAI.sttModel',
    userControlSurface: {
      kind: 'none',
      reason: 'No ordinary-user control; TTS settings expose only the OpenAI TTS model',
    },
    platformPolicyEligible: true,
    schema: sttModelSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.openAI.sttModel.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.openAI.ttsModel,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tts.openAI.ttsModel.desc',
    group: 'tts',
    options: [
      { labelKey: 'settingsPolicy.options.tts.ttsModel.gpt4oMini', value: 'gpt-4o-mini-tts' },
      { labelKey: 'settingsPolicy.options.tts.ttsModel.tts1', value: 'tts-1' },
      { labelKey: 'settingsPolicy.options.tts.ttsModel.tts1Hd', value: 'tts-1-hd' },
    ],
    path: 'tts.openAI.ttsModel',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/tts/features/OpenAI.tsx',
    },
    platformPolicyEligible: true,
    schema: ttsModelSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.openAI.ttsModel.title',
  }),

  // ── notification ─────────────────────────────────────────
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_NOTIFICATION_SETTINGS.email?.enabled ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.notification.email.enabled.desc',
    group: 'notification',
    path: 'notification.email.enabled',
    userControlSurface: {
      kind: 'none',
      reason: 'Notification settings page is a null business stub with no user control',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.notification.email.enabled.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_NOTIFICATION_SETTINGS.inbox?.enabled ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.notification.inbox.enabled.desc',
    group: 'notification',
    path: 'notification.inbox.enabled',
    userControlSurface: {
      kind: 'none',
      reason: 'Notification settings page is a null business stub with no user control',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.notification.inbox.enabled.title',
  }),

  // ── defaultAgent (non-secret leaves) ─────────────────────
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.model,
    control: 'text',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.model.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.model',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
    },
    platformPolicyEligible: true,
    schema: z.string().min(1).max(128),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.model.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.provider,
    control: 'text',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.provider.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.provider',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
    },
    platformPolicyEligible: true,
    schema: z.string().min(1).max(64),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.provider.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.systemRole ?? '',
    control: 'textarea',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.systemRole.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.systemRole',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent system-role control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.string().max(32_000),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.systemRole.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.chatConfig?.enableStreaming ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.enableStreaming.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.chatConfig.enableStreaming',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent streaming control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.enableStreaming.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.chatConfig?.historyCount ?? 20,
    control: 'number',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.historyCount.desc',
    group: 'defaultAgent',
    max: 200,
    min: 0,
    path: 'defaultAgent.config.chatConfig.historyCount',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent history-count control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.number().int().min(0).max(200),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.historyCount.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.params?.temperature ?? 1,
    control: 'slider',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.params.temperature.desc',
    group: 'defaultAgent',
    max: 2,
    min: 0,
    path: 'defaultAgent.config.params.temperature',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent temperature control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.number().min(0).max(2),
    schemaVersion: 1,
    sensitivity: 'public',
    step: 0.1,
    titleKey: 'settingsPolicy.paths.defaultAgent.config.params.temperature.title',
  }),

  // One select leaf per discrete thinking-effort chatConfig key. Shared title/desc;
  // per-key schema is `z.enum(definition.levels)` so a gpt-5.2-pro leaf rejects `low`.
  // No builtInDefault: materializing registry defaults (e.g. gpt5_2ReasoningEffort:'none')
  // would override model-specific runtime defaults in resolveEffortLevel. The leaf is
  // only present in chatConfig when a policy or user override exists.
  // Do not prefix-own `defaultAgent.config.chatConfig.*` — streaming/historyCount stay
  // on the settings-policy editor.
  ...EFFORT_CONTROL_KEYS.map((key) => {
    const definition = EFFORT_CONTROL_REGISTRY[key];
    return def({
      applicableClients: RUNTIME_CLIENTS,
      control: 'select',
      descriptionKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.effort.desc',
      group: 'defaultAgent',
      options: effortSelectOptions(definition.levels),
      path: `defaultAgent.config.chatConfig.${definition.configKey}`,
      userControlSurface: {
        kind: 'surface',
        surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
      },
      platformPolicyEligible: true,
      schema: effortLevelSchema(definition.levels),
      schemaVersion: 1,
      sensitivity: 'public',
      titleKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.effort.title',
    });
  }),

  // ── systemAgent (model/provider/enabled/contextLimit/reasoningEffort — no secrets) ──
  // Service-model page keys: topic, generationTopic, translation, historyCompress,
  // agentMeta, followUpAction, inputCompletion, promptRewrite,
  // memoryAnalysisAgentConfig, userMemoryPersonaWriter, userMemoryEmbedding.
  // reasoningEffort is registered for every service-model key except embeddings.
  // `thread` is deliberately unregistered (no model/provider surface either);
  // effort stays a dormant user-settings blob field until that row is surfaced.
  ...(
    [
      'topic',
      'generationTopic',
      'translation',
      'historyCompress',
      'agentMeta',
      'followUpAction',
      'inputCompletion',
      'promptRewrite',
      'memoryAnalysisAgentConfig',
      'userMemoryPersonaWriter',
      'userMemoryEmbedding',
    ] as const
  ).flatMap((key) => {
    const item = DEFAULT_SYSTEM_AGENT_CONFIG[key];
    const surface = {
      kind: 'surface' as const,
      surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
    };
    const entries: Def[] = [
      def({
        applicableClients: RUNTIME_CLIENTS,
        builtInDefault: item.model,
        control: 'text',
        descriptionKey: `settingsPolicy.paths.systemAgent.${key}.model.desc`,
        group: 'systemAgent',
        path: `systemAgent.${key}.model`,
        userControlSurface: surface,
        platformPolicyEligible: true,
        schema: z.string().min(1).max(128),
        schemaVersion: 1,
        sensitivity: 'public',
        titleKey: `settingsPolicy.paths.systemAgent.${key}.model.title`,
      }),
      def({
        applicableClients: RUNTIME_CLIENTS,
        builtInDefault: item.provider,
        control: 'text',
        descriptionKey: `settingsPolicy.paths.systemAgent.${key}.provider.desc`,
        group: 'systemAgent',
        path: `systemAgent.${key}.provider`,
        userControlSurface: surface,
        platformPolicyEligible: true,
        schema: z.string().min(1).max(64),
        schemaVersion: 1,
        sensitivity: 'public',
        titleKey: `settingsPolicy.paths.systemAgent.${key}.provider.title`,
      }),
    ];

    if (key === 'followUpAction' || key === 'inputCompletion' || key === 'promptRewrite') {
      entries.push(
        def({
          applicableClients: RUNTIME_CLIENTS,
          builtInDefault: item.enabled ?? false,
          control: 'switch',
          descriptionKey: `settingsPolicy.paths.systemAgent.${key}.enabled.desc`,
          group: 'systemAgent',
          path: `systemAgent.${key}.enabled`,
          userControlSurface: surface,
          platformPolicyEligible: true,
          schema: z.boolean(),
          schemaVersion: 1,
          sensitivity: 'public',
          titleKey: `settingsPolicy.paths.systemAgent.${key}.enabled.title`,
        }),
      );
    }

    if (
      key === 'memoryAnalysisAgentConfig' ||
      key === 'userMemoryPersonaWriter' ||
      key === 'userMemoryEmbedding'
    ) {
      entries.push(
        def({
          applicableClients: RUNTIME_CLIENTS,
          builtInDefault: null,
          control: 'number',
          descriptionKey: `settingsPolicy.paths.systemAgent.${key}.contextLimit.desc`,
          group: 'systemAgent',
          max: 2_000_000,
          min: 1,
          path: `systemAgent.${key}.contextLimit`,
          userControlSurface: surface,
          platformPolicyEligible: true,
          schema: z.number().int().min(1).max(2_000_000).nullable(),
          schemaVersion: 1,
          sensitivity: 'public',
          titleKey: `settingsPolicy.paths.systemAgent.${key}.contextLimit.title`,
        }),
      );
    }

    return entries;
  }),

  // reasoningEffort is a nullable leaf, same as `systemAgent.<key>.contextLimit`:
  // admin clear writes `null` ("provider default"); builtInDefault is `null` so
  // an unset policy also reads as absent. Shared title/desc keys.
  ...SYSTEM_AGENT_REASONING_EFFORT_KEYS.map((key) =>
    def({
      applicableClients: RUNTIME_CLIENTS,
      builtInDefault: null,
      control: 'select',
      descriptionKey: 'settingsPolicy.paths.systemAgent.reasoningEffort.desc',
      group: 'systemAgent',
      options: SYSTEM_AGENT_REASONING_EFFORT_OPTIONS,
      path: `systemAgent.${key}.reasoningEffort`,
      userControlSurface: {
        kind: 'surface',
        surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
      },
      platformPolicyEligible: true,
      schema: systemAgentReasoningEffortSchema.nullable(),
      schemaVersion: 1,
      sensitivity: 'public',
      titleKey: 'settingsPolicy.paths.systemAgent.reasoningEffort.title',
    }),
  ),
];

/** Paths that must never enter the registry (defense-in-depth denylist). */
export const SETTINGS_SECRET_PATH_PREFIXES = ['keyVaults', 'market', 'languageModel'] as const;

/** Fail closed at module load on bad registry metadata. */
const assertRegistryValid = (entries: readonly Def[]) => {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`Duplicate settings registry path: ${entry.path}`);
    }
    seen.add(entry.path);
    if (entry.sensitivity === 'secret') {
      throw new Error(`Secret path must not be registered: ${entry.path}`);
    }
    if (!entry.path || entry.path.includes('..')) {
      throw new Error(`Invalid settings path: ${entry.path}`);
    }
    if (entry.builtInDefault !== undefined) {
      const parsed = entry.schema.safeParse(entry.builtInDefault);
      if (!parsed.success) {
        throw new Error(
          `Invalid built-in default for ${entry.path}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
    }
    if (entry.applicableClients.length === 0) {
      throw new Error(`applicableClients empty for ${entry.path}`);
    }
    if (
      entry.userControlSurface.kind === 'surface' &&
      !entry.userControlSurface.surfaceFile.startsWith('src/')
    ) {
      throw new Error(`Invalid user control surface for ${entry.path}`);
    }
    if (
      entry.userControlSurface.kind === 'none' &&
      entry.userControlSurface.reason.trim().length === 0
    ) {
      throw new Error(`Missing user control omission reason for ${entry.path}`);
    }
  }
};

assertRegistryValid(REGISTRY_ENTRIES);

const byPath = new Map<string, Def>(REGISTRY_ENTRIES.map((e) => [e.path, e]));

/**
 * Stable, side-effect-free canonical view for ordinary-user control coverage.
 * Tests consume this instead of maintaining an independently editable path list.
 */
export const SETTINGS_USER_CONTROL_SURFACE_COVERAGE = Object.freeze(
  REGISTRY_ENTRIES.map(({ path, userControlSurface }) =>
    Object.freeze({ path, userControlSurface }),
  ),
);

export class SettingsRegistry {
  readonly version = SETTINGS_REGISTRY_VERSION;

  list = (): readonly Def[] => REGISTRY_ENTRIES;

  listByGroup = (group: SettingGroupId): readonly Def[] =>
    REGISTRY_ENTRIES.filter((e) => e.group === group);

  get = (path: string): Def | undefined => byPath.get(path);

  has = (path: string): boolean => byPath.has(path);

  isSecretPath = (path: string): boolean => {
    if (!path) return true;
    return SETTINGS_SECRET_PATH_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}.`),
    );
  };

  /**
   * Fail-closed path gate. Returns a stable business code string or null when ok.
   */
  assertPathWritable = (params: {
    path: string;
    client?: SettingClientSurface;
    requirePlatformEligible?: boolean;
  }):
    | 'MANAGED_SETTING_UNKNOWN_PATH'
    | 'MANAGED_SETTING_SECRET_PATH'
    | 'MANAGED_SETTING_INAPPLICABLE_CLIENT'
    | 'MANAGED_SETTING_NOT_POLICY_ELIGIBLE'
    | null => {
    const { path, client, requirePlatformEligible } = params;

    if (this.isSecretPath(path)) return 'MANAGED_SETTING_SECRET_PATH';

    const entry = this.get(path);
    if (!entry) return 'MANAGED_SETTING_UNKNOWN_PATH';

    if (entry.sensitivity === 'secret' || entry.sensitivity === 'sensitive') {
      return 'MANAGED_SETTING_SECRET_PATH';
    }

    if (requirePlatformEligible && !entry.platformPolicyEligible) {
      return 'MANAGED_SETTING_NOT_POLICY_ELIGIBLE';
    }

    if (client && entry.applicableClients.length > 0 && !entry.applicableClients.includes(client)) {
      return 'MANAGED_SETTING_INAPPLICABLE_CLIENT';
    }

    return null;
  };

  validateValue = (
    path: string,
    value: unknown,
  ): { ok: true; value: unknown } | { ok: false; message: string } => {
    const entry = this.get(path);
    if (!entry) return { ok: false, message: 'Unknown path' };
    const parsed = entry.schema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        message: parsed.error.issues.map((i) => i.message).join('; ') || 'Invalid value',
      };
    }
    return { ok: true, value: parsed.data };
  };

  /** All registered paths (stable order). */
  paths = (): readonly string[] => REGISTRY_ENTRIES.map((e) => e.path);
}

/** Singleton registry instance. */
export const settingsRegistry = new SettingsRegistry();
