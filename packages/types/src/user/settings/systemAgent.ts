/**
 * Superset of every discrete "thinking effort" level any model family exposes.
 * A stored value is clamped onto the levels the selected model actually offers
 * (see `EFFORT_CONTROL_REGISTRY` in @lobechat/model-runtime) before being applied.
 */
export type SystemAgentReasoningEffort =
  | 'no_think'
  | 'disabled'
  | 'none'
  | 'minimal'
  | 'auto'
  | 'instant'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'pro'
  | 'enabled';

export interface SystemAgentItem {
  contextLimit?: number;
  customPrompt?: string;
  enabled?: boolean;
  model: string;
  provider: string;
  /**
   * Default thinking-effort level applied when this service model runs.
   * `null` is an explicit clear (falls back to the provider default) — needed
   * because the settings merge drops `undefined` values.
   */
  reasoningEffort?: SystemAgentReasoningEffort | null;
}

export interface PromptRewriteSystemAgent extends Omit<SystemAgentItem, 'enabled'> {
  enabled: boolean;
}

export interface UserSystemAgentConfig {
  agentMeta: SystemAgentItem;
  followUpAction: SystemAgentItem;
  generationTopic: SystemAgentItem;
  historyCompress: SystemAgentItem;
  inputCompletion: SystemAgentItem;
  promptRewrite: PromptRewriteSystemAgent;
  thread: SystemAgentItem;
  topic: SystemAgentItem;
  translation: SystemAgentItem;
}

export interface UserMemoryServiceModelConfig {
  memoryAnalysisAgentConfig: SystemAgentItem;
  userMemoryEmbedding: SystemAgentItem;
  userMemoryPersonaWriter: SystemAgentItem;
}

export interface UserServiceModelConfig
  extends UserSystemAgentConfig, UserMemoryServiceModelConfig {}

export type UserSystemAgentConfigKey = keyof UserSystemAgentConfig;
export type UserMemoryServiceModelConfigKey = keyof UserMemoryServiceModelConfig;
export type UserServiceModelConfigKey = keyof UserServiceModelConfig;
