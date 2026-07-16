/**
 * Authoritative mapping of registry paths that have existing ordinary-user controls.
 * Coverage test imports server registry and requires every path with a surface here
 * to be wired; registry paths intentionally without a control are listed in
 * REGISTRY_PATHS_WITHOUT_USER_CONTROL.
 */

export type ControlSurface = {
  /** Dot path matching settings registry. */
  path: string;
  /** Repo-relative file that must consume managed metadata. */
  surfaceFile: string;
};

/**
 * Every registry path that already has a real user-facing control must appear here.
 * Adding a registry path with a control but no row fails the coverage test.
 */
export const PLATFORM_SETTING_CONTROL_SURFACES: readonly ControlSurface[] = [
  {
    path: 'general.animationMode',
    surfaceFile: 'src/routes/(main)/settings/common/features/Common/Common.tsx',
  },
  {
    path: 'general.telemetry',
    surfaceFile: 'src/routes/(main)/settings/about/features/Analytics.tsx',
  },
  {
    path: 'general.transitionMode',
    surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
  },
  {
    path: 'general.enableAutoScrollOnStreaming',
    surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
  },
  {
    path: 'general.enableMessageLinkIcon',
    surfaceFile: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/index.tsx',
  },
  {
    path: 'memory.enabled',
    surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
  },
  {
    path: 'memory.effort',
    surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
  },
  {
    path: 'image.defaultImageNum',
    surfaceFile: 'src/routes/(main)/settings/image/features/Image.tsx',
  },
] as const;

/**
 * Registry paths that intentionally have no ordinary-user control surface yet
 * (admin-policy only / nested agent leaves / etc.).
 */
export const REGISTRY_PATHS_WITHOUT_USER_CONTROL = [
  'general.fontSize',
  'general.isLiteMode',
  'general.costEstimateWarningThreshold',
  'tool.humanIntervention.approvalMode',
  'tts.sttAutoStop',
  'tts.sttServer',
  'tts.openAI.sttModel',
  'tts.openAI.ttsModel',
  'notification.email.enabled',
  'notification.inbox.enabled',
  'defaultAgent.config.model',
  'defaultAgent.config.provider',
  'defaultAgent.config.systemRole',
  'defaultAgent.config.chatConfig.enableStreaming',
  'defaultAgent.config.chatConfig.historyCount',
  'defaultAgent.config.params.temperature',
  'systemAgent.topic.model',
  'systemAgent.topic.provider',
  'systemAgent.translation.model',
  'systemAgent.historyCompress.model',
] as const;
