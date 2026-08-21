import { shouldOmitBuiltinInboxSystemRole } from '@lobechat/builtin-agents';
import { PageAgentIdentifier } from '@lobechat/builtin-tool-page-agent';
import { MessagesEngine } from '@lobechat/context-engine';
import { type OpenAIChatMessage } from '@lobechat/types';
import { isWebAppProvider } from 'model-bank/modelProviders';

import { type ServerMessagesEngineParams } from './types';

/**
 * Create server-side variable generators with runtime context
 * These are safe to use in Node.js environment
 */
const createServerVariableGenerators = (params: {
  model?: string;
  provider?: string;
  timezone?: string;
}) => {
  const { model, provider, timezone } = params;
  const tz = timezone || 'UTC';
  return {
    // Time-related variables (localized to user's timezone)
    date: () => new Date().toLocaleDateString('en-US', { dateStyle: 'full', timeZone: tz }),
    datetime: () => new Date().toLocaleString('en-US', { timeZone: tz }),
    time: () => new Date().toLocaleTimeString('en-US', { timeStyle: 'medium', timeZone: tz }),
    timezone: () => tz,
    // Model-related variables
    model: () => model ?? '',
    provider: () => provider ?? '',
    // Working directory fallback. Unlike the client generator, the server has no
    // store to resolve cwd from — the real value arrives via `additionalVariables`
    // (`deviceSystemInfo.workingDirectory`, only set when a device-run's bound cwd
    // resolves) and overrides this through the spread order below. Without this
    // fallback, a device-run whose cwd can't be resolved (e.g. a web-originated
    // session with no bound directory) leaves `{{workingDirectory}}` unmatched and
    // leaks the literal into the local-system system prompt (LOBE-11473).
    workingDirectory: () => '(not specified, use user Home directory as default)',
  };
};

/**
 * Server-side messages engine function
 *
 * This function wraps MessagesEngine for server-side usage.
 * Unlike the frontend version, it receives all data as parameters
 * instead of fetching from stores.
 *
 * @example
 * ```typescript
 * const messages = await serverMessagesEngine({
 *   messages: chatMessages,
 *   model: 'gpt-4',
 *   provider: 'openai',
 *   systemRole: 'You are a helpful assistant',
 *   knowledge: {
 *     fileContents: [...],
 *     knowledgeBases: [...],
 *   },
 * });
 * ```
 */
export const serverMessagesEngine = async ({
  messages = [],
  model,
  modelDisplayName,
  modelKnowledgeCutoff,
  provider,
  systemRole,
  inputTemplate,
  enableAgentMode,
  enableHistoryCount,
  enableModelInfo,
  enableSystemDate,
  forceFinish,
  historyCount,
  historySummary,
  formatHistorySummary,
  initialContext,
  knowledge,
  agentDocuments,
  agentSlug,
  skillsConfig,
  toolDiscoveryConfig,
  toolsConfig,
  capabilities,
  userMemory,
  agentBuilderContext,
  agentGroup,
  botPlatformContext,
  discordContext,
  evalContext,
  agentManagementContext,
  onboardingContext,
  pageContentContext,
  topicReferences,
  additionalVariables,
  userLocale,
  userTimezone,
}: ServerMessagesEngineParams): Promise<OpenAIChatMessage[]> => {
  const isWebApp = isWebAppProvider(provider);
  // Web-app providers skip generic date / model-info injections. An explicit
  // caller `false` stays off for every provider (off stays off).
  const resolvedEnableSystemDate = isWebApp ? false : enableSystemDate;
  const resolvedEnableModelInfo = isWebApp ? false : enableModelInfo;
  const resolvedSystemRole =
    isWebApp && shouldOmitBuiltinInboxSystemRole({ agentSlug, systemRole, userLocale })
      ? ''
      : systemRole;

  const engine = new MessagesEngine({
    // Capability injection
    capabilities: {
      isCanUseAudio: capabilities?.isCanUseAudio,
      isCanUseFC: capabilities?.isCanUseFC,
      isCanUseFiles: capabilities?.isCanUseFiles,
      isCanUseVideo: capabilities?.isCanUseVideo,
      isCanUseVision: capabilities?.isCanUseVision,
    },

    // Agent configuration
    enableAgentMode,
    enableHistoryCount,
    enableModelInfo: resolvedEnableModelInfo,
    enableSystemDate: resolvedEnableSystemDate,

    // Server-side file access URLs resolve to stable file-proxy URLs in production.
    fileContext: { enabled: true, includeFileUrl: true },

    // Force finish mode (inject summary prompt when maxSteps exceeded)
    forceFinish,

    formatHistorySummary,

    historyCount,

    historySummary,

    inputTemplate,

    initialContext,

    // Knowledge injection
    knowledge: {
      fileContents: knowledge?.fileContents,
      knowledgeBases: knowledge?.knowledgeBases,
    },
    agentDocuments,

    // Messages
    messages,

    // Model info
    model,
    modelDisplayName,
    modelKnowledgeCutoff,

    provider,
    systemRole: resolvedSystemRole,

    // Timezone for system date provider
    timezone: userTimezone,

    // Tools configuration
    toolDiscoveryConfig,
    toolsConfig: {
      disabledToolIdentifiers:
        toolsConfig?.disabledToolIdentifiers ??
        (toolsConfig?.tools?.includes(PageAgentIdentifier) ? undefined : [PageAgentIdentifier]),
      manifests: toolsConfig?.manifests,
      tools: toolsConfig?.tools,
    },

    // User memory configuration
    userMemory: userMemory?.memories
      ? {
          enabled: true,
          fetchedAt: userMemory.fetchedAt,
          memories: userMemory.memories,
        }
      : undefined,

    // Server-side variable generators (with model/provider context + device paths)
    variableGenerators: {
      ...createServerVariableGenerators({ model, provider, timezone: userTimezone }),
      ...Object.fromEntries(
        Object.entries(additionalVariables ?? {}).map(([k, v]) => [k, () => v]),
      ),
    },

    // Skills configuration
    ...(skillsConfig?.enabledSkills && skillsConfig.enabledSkills.length > 0 && { skillsConfig }),

    // Topic references
    ...(topicReferences && topicReferences.length > 0 && { topicReferences }),

    // Extended contexts
    ...(agentBuilderContext && { agentBuilderContext }),
    ...(agentGroup && { agentGroup }),
    ...(botPlatformContext && { botPlatformContext }),
    ...(discordContext && { discordContext }),
    ...(evalContext && { evalContext }),
    ...(onboardingContext && { onboardingContext }),
    ...(agentManagementContext && { agentManagementContext }),
    ...(pageContentContext && { pageContentContext }),
  });

  const result = await engine.process();
  return result.messages;
};

// Re-export types
export type {
  BotPlatformContext,
  EvalContext,
  ServerKnowledgeConfig,
  ServerMessagesEngineParams,
  ServerModelCapabilities,
  ServerToolsConfig,
  ServerUserMemoryConfig,
} from './types';
