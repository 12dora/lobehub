import type { AgentEvent, AgentInstruction, InstructionExecutor } from '@lobechat/agent-runtime';
import { type CreateMessageParams } from '@lobechat/types';
import pMap from 'p-map';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

/** Creates aborted tool messages for cancelled calls. */
export const createResolveAbortedToolsExecutor = (
  context: AgentExecutorContext,
): InstructionExecutor => {
  return async (instruction, state) => {
    const { parentMessageId, toolsCalling } = (
      instruction as Extract<AgentInstruction, { type: 'resolve_aborted_tools' }>
    ).payload;

    const events: AgentEvent[] = [];
    const sessionLogId = `${state.operationId}:${state.stepCount}`;
    const newState = structuredClone(state);

    log(
      '[%s][resolve_aborted_tools] Resolving %d aborted tools',
      sessionLogId,
      toolsCalling.length,
    );

    // Get context from operation
    const opContext = context.getOperationContext();
    // Get effective agentId (subAgentId for group orchestration)
    const effectiveAgentId = context.getEffectiveAgentId();

    // Create tool messages for each aborted tool
    await pMap(toolsCalling, async (toolPayload) => {
      const toolName = `${toolPayload.identifier}/${toolPayload.apiName}`;
      log(
        '[%s][resolve_aborted_tools] Creating aborted tool message for %s',
        sessionLogId,
        toolName,
      );

      const toolMessageParams: CreateMessageParams = {
        content: 'Tool execution was aborted by user.',
        groupId: opContext.groupId,
        parentId: parentMessageId,
        plugin: toolPayload,
        pluginIntervention: { status: 'aborted' },
        role: 'tool',
        agentId: effectiveAgentId!,
        threadId: opContext.threadId,
        tool_call_id: toolPayload.id,
        topicId: opContext.topicId ?? undefined,
      };

      const createResult = await context
        .get()
        .optimisticCreateMessage(toolMessageParams, { operationId: context.operationId });

      if (createResult) {
        log(
          '[%s][resolve_aborted_tools] Created aborted tool message: %s for %s',
          sessionLogId,
          createResult.id,
          toolName,
        );
      }
    });

    log('[%s][resolve_aborted_tools] All aborted tool messages created', sessionLogId);

    // Mark state as done since we're finishing after abort
    newState.lastModified = new Date().toISOString();
    newState.status = 'done';

    events.push({
      finalState: newState,
      reason: 'user_aborted',
      reasonDetail: 'User aborted operation with pending tool calls',
      type: 'done',
    });

    return { events, newState };
  };
};
