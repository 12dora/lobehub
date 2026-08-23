import type { AgentEvent, AgentInstruction, InstructionExecutor } from '@lobechat/agent-runtime';
import { type CreateMessageParams } from '@lobechat/types';
import pMap from 'p-map';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

/** Creates pending tool messages and waits for human approval. */
export const createRequestHumanApproveExecutor = (
  context: AgentExecutorContext,
): InstructionExecutor => {
  return async (instruction, state) => {
    const { pendingToolsCalling, reason, skipCreateToolMessage } = instruction as Extract<
      AgentInstruction,
      { type: 'request_human_approve' }
    >;
    const newState = structuredClone(state);
    const events: AgentEvent[] = [];
    const sessionLogId = `${state.operationId}:${state.stepCount}`;

    log(
      '[%s][request_human_approve] Executor start, pending tools count: %d, reason: %s',
      sessionLogId,
      pendingToolsCalling.length,
      reason || 'human_intervention_required',
    );

    // Update state to waiting_for_human
    newState.lastModified = new Date().toISOString();
    newState.status = 'waiting_for_human';
    newState.pendingToolsCalling = pendingToolsCalling;

    // Get assistant message to extract groupId and parentId
    const latestMessages = context.get().dbMessagesMap[context.messageKey] || [];
    const assistantMessage = latestMessages.findLast((m) => m.role === 'assistant');

    if (!assistantMessage) {
      log('[%s][request_human_approve] ERROR: No assistant message found', sessionLogId);
      throw new Error('No assistant message found for intervention');
    }

    log(
      '[%s][request_human_approve] Found assistant message: %s',
      sessionLogId,
      assistantMessage.id,
    );

    if (skipCreateToolMessage) {
      // Resumption mode: Tool messages already exist, just verify them
      log('[%s][request_human_approve] Resuming with existing tool messages', sessionLogId);
    } else {
      // Get context from operation
      const opContext = context.getOperationContext();
      // Get effective agentId (subAgentId for group orchestration)
      const effectiveAgentId = context.getEffectiveAgentId();

      // Create tool messages for each pending tool call with intervention status
      await pMap(pendingToolsCalling, async (toolPayload) => {
        const toolName = `${toolPayload.identifier}/${toolPayload.apiName}`;
        log(
          '[%s][request_human_approve] Creating tool message for %s with tool_call_id: %s',
          sessionLogId,
          toolName,
          toolPayload.id,
        );

        const toolMessageParams: CreateMessageParams = {
          content: '',
          groupId: assistantMessage.groupId,
          parentId: assistantMessage.id,
          plugin: {
            ...toolPayload,
          },
          pluginIntervention: { status: 'pending' },
          role: 'tool',
          agentId: effectiveAgentId!,
          threadId: opContext.threadId,
          tool_call_id: toolPayload.id,
          topicId: opContext.topicId ?? undefined,
        };

        const createResult = await context
          .get()
          .optimisticCreateMessage(toolMessageParams, { operationId: context.operationId });

        if (!createResult) {
          log(
            '[%s][request_human_approve] ERROR: Failed to create tool message for %s',
            sessionLogId,
            toolName,
          );
          throw new Error(`Failed to create tool message for ${toolName}`);
        }

        log(
          '[%s][request_human_approve] Created tool message: %s for %s',
          sessionLogId,
          createResult.id,
          toolName,
        );
      });
    }

    log(
      '[%s][request_human_approve] All tool messages created, emitting human_approve_required event',
      sessionLogId,
    );

    events.push({
      operationId: newState.operationId,
      pendingToolsCalling,
      type: 'human_approve_required',
    });

    return { events, newState };
  };
};
