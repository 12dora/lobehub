import type { AgentRuntimeContext } from '@lobechat/agent-runtime';
import { dedupeBy } from '@lobechat/utils';

import type { AgentExecutorContext } from '../shared';
import { log } from '../shared';

interface ResolveCallLlmRuntimeParams {
  context: AgentExecutorContext;
  runtimeContext: AgentRuntimeContext | undefined;
  stagePrefix: string;
}

/**
 * Reads everything this turn needs out of the store, the operation and the agent
 * config: store actions, the operation itself, the responding agent, and the tool
 * set actually offered to the model.
 */
export const resolveCallLlmRuntime = ({
  context,
  runtimeContext,
  stagePrefix,
}: ResolveCallLlmRuntimeParams) => {
  const {
    optimisticUpdateMessageContent,
    internal_dispatchMessage,
    internal_toggleToolCallingStreaming,
  } = context.get();

  // Get agentId, topicId, groupId and abortController from operation
  const operation = context.get().operations[context.operationId];
  if (!operation) {
    throw new Error(`Operation not found: ${context.operationId}`);
  }
  const { subAgentId, groupId, topicId } = operation.context;
  const abortController = operation.abortController;

  // In group orchestration, subAgentId is the actual responding agent
  const agentId = groupId && subAgentId ? subAgentId : operation.context.agentId!;

  const traceId = operation.metadata?.traceId;

  const fetchContext = { ...operation.context, agentId };

  const { agentConfig: agentConfigData } = context.agentConfig;

  // Expand dynamically activated tools (from lobe-activator activateTools API)
  // and merge them into the agent config for this LLM call.
  // Built before the StreamingHandler so we can bind the offered tool
  // names into the transformToolCalls callback ().
  const activatedToolIds = runtimeContext?.stepContext?.activatedToolIds;
  let resolvedAgentConfig = context.agentConfig;

  if (activatedToolIds?.length && context.toolsEngine) {
    const additional = context.toolsEngine.generateToolsDetailed({
      context: { isExplicitActivation: true },
      model: agentConfigData.model,
      provider: agentConfigData.provider!,
      skipDefaultTools: true,
      toolIds: activatedToolIds,
    });

    if (additional.tools?.length) {
      const mergedEnabledManifests = dedupeBy(
        [...(context.agentConfig.enabledManifests || []), ...additional.enabledManifests],
        (manifest) => manifest.identifier,
      );
      const mergedEnabledToolIds = [
        ...new Set([...(context.agentConfig.enabledToolIds || []), ...additional.enabledToolIds]),
      ];
      const mergedTools = dedupeBy(
        [...(context.agentConfig.tools || []), ...additional.tools],
        (tool) => tool.function.name,
      );

      resolvedAgentConfig = {
        ...context.agentConfig,
        enabledManifests: mergedEnabledManifests,
        enabledToolIds: mergedEnabledToolIds,
        tools: mergedTools,
      };

      log(
        `${stagePrefix} Injected %d activated tools: %o`,
        activatedToolIds.length,
        activatedToolIds,
      );
    }
  }

  // Names of tools actually sent to the LLM this turn. Passed to the
  // resolver's missing-prefix fallback so a model can't reach tools that
  // weren't enabled, and disabled duplicates can't shadow enabled calls.
  const offeredToolNames = (resolvedAgentConfig.tools ?? []).map((tool) => tool.function.name);

  return {
    abortController,
    agentConfigData,
    agentId,
    fetchContext,
    groupId,
    internal_dispatchMessage,
    internal_toggleToolCallingStreaming,
    offeredToolNames,
    operation,
    optimisticUpdateMessageContent,
    resolvedAgentConfig,
    topicId,
    traceId,
  };
};

export type CallLlmRuntime = ReturnType<typeof resolveCallLlmRuntime>;
