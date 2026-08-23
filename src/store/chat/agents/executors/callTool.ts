import type {
  AgentEvent,
  AgentInstructionCallTool,
  AgentRuntimeContext,
  GeneralAgentCallingToolInstructionPayload,
  GeneralAgentCallToolResultPayload,
  InstructionExecutor,
} from '@lobechat/agent-runtime';
import { UsageCounter } from '@lobechat/agent-runtime';
import { CloudSandboxIdentifier } from '@lobechat/builtin-tool-cloud-sandbox';
import { type ChatToolPayload, type CreateMessageParams } from '@lobechat/types';

import { cloudSandboxService } from '@/services/cloudSandbox';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

// Tool pricing configuration (USD per call)
const TOOL_PRICING: Record<string, number> = {
  'lobe-web-browsing/craw': 0.002,
  'lobe-web-browsing/search': 0.001,
};

/** Creates tool messages and executes tool calls. */
export const createCallToolExecutor = (context: AgentExecutorContext): InstructionExecutor => {
  return async (instruction, state, runtimeContext) => {
    const payload = (instruction as AgentInstructionCallTool)
      .payload as GeneralAgentCallingToolInstructionPayload;

    const events: AgentEvent[] = [];
    const sessionLogId = `${state.operationId}:${state.stepCount}`;

    log('[%s][call_tool] Executor start, payload: %O', sessionLogId, payload);

    // Convert CallingToolPayload to ChatToolPayload for ToolExecutionService
    const chatToolPayload: ChatToolPayload = payload.toolCalling;

    const toolName = `${chatToolPayload.identifier}/${chatToolPayload.apiName}`;
    const startTime = performance.now();

    // Get context from operation
    const opContext = context.getOperationContext();
    // Get assistant message to derive the same-turn source user message when the root
    // runtime operation is anchored to the assistant message.
    const latestMessages = context.get().dbMessagesMap[context.messageKey] || [];
    const existingToolMessage = payload.skipCreateToolMessage
      ? latestMessages.find((m) => m.id === payload.parentMessageId)
      : undefined;
    const assistantMessage =
      latestMessages.find((m) => m.id === payload.parentMessageId && m.role === 'assistant') ??
      (existingToolMessage?.parentId
        ? latestMessages.find(
            (m) => m.id === existingToolMessage.parentId && m.role === 'assistant',
          )
        : undefined) ??
      (opContext.messageId
        ? latestMessages.find((m) => m.id === opContext.messageId && m.role === 'assistant')
        : undefined) ??
      latestMessages.findLast((m) => m.role === 'assistant');
    const sourceMessageId =
      opContext.sourceMessageId ??
      assistantMessage?.parentId ??
      (opContext.messageId !== assistantMessage?.id ? opContext.messageId : undefined);

    // ============ Create toolCalling operation (top-level) ============
    const { operationId: toolOperationId } = context.get().startOperation({
      type: 'toolCalling',
      context: {
        agentId: opContext.agentId!,
        groupId: opContext.groupId,
        scope: opContext.scope,
        sourceMessageId,
        topicId: opContext.topicId,
        threadId: opContext.threadId,
        viewedTask: opContext.viewedTask,
      },
      parentOperationId: context.operationId,
      metadata: {
        startTime: Date.now(),
        identifier: chatToolPayload.identifier,
        apiName: chatToolPayload.apiName,
        tool_call_id: chatToolPayload.id,
      },
    });

    try {
      let toolMessageId: string;

      if (payload.skipCreateToolMessage) {
        // Reuse existing tool message (resumption mode)
        toolMessageId = payload.parentMessageId;

        log(
          '[%s][call_tool] Resuming with existing tool message: %s (status: %s)',
          sessionLogId,
          toolMessageId,
          existingToolMessage?.pluginIntervention?.status,
        );
      } else {
        // Create new tool message (normal mode)
        log(
          '[%s][call_tool] Creating tool message for tool_call_id: %s',
          sessionLogId,
          chatToolPayload.id,
        );

        // ============ Sub-operation 1: Create tool message ============
        const createToolMsgOpId = context.get().startOperation({
          type: 'createToolMessage',
          context: {
            agentId: opContext.agentId!,
            topicId: opContext.topicId,
            threadId: opContext.threadId,
          },
          parentOperationId: toolOperationId,
          metadata: {
            startTime: Date.now(),
            tool_call_id: chatToolPayload.id,
          },
        }).operationId;

        // Register cancel handler: Ensure message creation completes, then mark as aborted
        context.get().onOperationCancel(createToolMsgOpId, async ({ metadata }) => {
          log(
            '[%s][call_tool] createToolMessage cancelled, ensuring creation completes',
            sessionLogId,
          );

          // Wait for message creation to complete (ensure-complete strategy)
          const createResult = await metadata?.createMessagePromise;
          if (createResult) {
            const msgId = createResult.id;
            // Update message to aborted state
            await Promise.all([
              context
                .get()
                .optimisticUpdateMessageContent(
                  msgId,
                  'Tool execution was cancelled by user.',
                  undefined,
                  { operationId: createToolMsgOpId },
                ),
              context
                .get()
                .optimisticUpdateMessagePlugin(
                  msgId,
                  { intervention: { status: 'aborted' } },
                  { operationId: createToolMsgOpId },
                ),
            ]);
          }
        });

        // Execute creation and save Promise to metadata
        // Use effective agentId (subAgentId for group orchestration)
        const effectiveAgentId = context.getEffectiveAgentId();
        const toolMessageParams: CreateMessageParams = {
          content: '',
          groupId: assistantMessage?.groupId,
          parentId: payload.parentMessageId,
          plugin: chatToolPayload,
          role: 'tool',
          agentId: effectiveAgentId!,
          threadId: opContext.threadId,
          tool_call_id: chatToolPayload.id,
          topicId: opContext.topicId ?? undefined,
        };

        const createPromise = context
          .get()
          .optimisticCreateMessage(toolMessageParams, { operationId: createToolMsgOpId });
        context.get().updateOperationMetadata(createToolMsgOpId, {
          createMessagePromise: createPromise,
        });
        const createResult = await createPromise;

        if (!createResult) {
          context.get().failOperation(createToolMsgOpId, {
            type: 'CreateMessageError',
            message: `Failed to create tool message for tool_call_id: ${chatToolPayload.id}`,
          });
          throw new Error(`Failed to create tool message for tool_call_id: ${chatToolPayload.id}`);
        }

        toolMessageId = createResult.id;
        log('[%s][call_tool] Created tool message, id: %s', sessionLogId, toolMessageId);
        context.get().completeOperation(createToolMsgOpId);
      }

      // Check if parent operation was cancelled while creating message
      const toolOperation = toolOperationId ? context.get().operations[toolOperationId] : undefined;
      if (toolOperation?.abortController.signal.aborted) {
        log('[%s][call_tool] Parent operation cancelled, skipping tool execution', sessionLogId);
        // Message already created with aborted status by cancel handler
        return { events, newState: state };
      }

      // ============ Sub-operation 2: Execute tool call ============
      // Auto-associates message with this operation via messageId in context
      const { operationId: executeToolOpId } = context.get().startOperation({
        type: 'executeToolCall',
        context: {
          messageId: toolMessageId,
        },
        parentOperationId: toolOperationId,
        metadata: {
          startTime: Date.now(),
          tool_call_id: chatToolPayload.id,
        },
      });

      log(
        '[%s][call_tool] Created executeToolCall operation %s for message %s',
        sessionLogId,
        executeToolOpId,
        toolMessageId,
      );

      // Register cancel handler: Just update message (message already exists)
      context.get().onOperationCancel(executeToolOpId, async () => {
        log('[%s][call_tool] executeToolCall cancelled, updating message', sessionLogId);

        if (chatToolPayload.identifier === CloudSandboxIdentifier && opContext.topicId) {
          void cloudSandboxService.interrupt(opContext.topicId).catch((error) => {
            log('[%s][call_tool] sandbox interrupt failed: %O', sessionLogId, error);
          });
        }

        // Update message to aborted state (cleanup strategy)
        await Promise.all([
          context
            .get()
            .optimisticUpdateMessageContent(
              toolMessageId,
              'Tool execution was cancelled by user.',
              undefined,
              { operationId: executeToolOpId },
            ),
          context
            .get()
            .optimisticUpdateMessagePlugin(
              toolMessageId,
              { intervention: { status: 'aborted' } },
              { operationId: executeToolOpId },
            ),
        ]);
      });

      // Execute tool - abort handling is done by cancel handler
      // Pass stepContext from runtimeContext for dynamic state access
      log(
        '[%s][call_tool] Executing tool %s (hasTodos=%s) ...',
        sessionLogId,
        toolName,
        !!runtimeContext?.stepContext?.todos,
      );
      const result = await context
        .get()
        .internal_invokeDifferentTypePlugin(
          toolMessageId,
          chatToolPayload,
          runtimeContext?.stepContext,
        );

      // Check if operation was cancelled during tool execution
      const executeToolOperation = context.get().operations[executeToolOpId];
      if (executeToolOperation?.abortController.signal.aborted) {
        log('[%s][call_tool] Tool execution completed but operation was cancelled', sessionLogId);
        // Don't complete - cancel handler already updated message to aborted
        return { events, newState: state };
      }

      context.get().completeOperation(executeToolOpId);

      const executionTime = Math.round(performance.now() - startTime);

      // Fallback for undefined result (e.g. tool executor not found or returned nothing)
      if (result === undefined || result === null) {
        const fallbackResult = {
          content: `Tool ${toolName} execution failed: no result returned`,
          error: { type: 'ToolExecutionError', message: 'Tool returned no result' },
          success: false,
        };

        if (toolOperationId) {
          context.get().failOperation(toolOperationId, {
            message: 'Tool returned no result',
            type: 'ToolExecutionError',
          });
        }

        events.push({ id: chatToolPayload.id, result: fallbackResult, type: 'tool_result' });

        const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
        return { events, newState: { ...state, messages: updatedMessages } };
      }

      const isSuccess = result && !result.error;

      log(
        '[%s][call_tool] Executing %s in %dms, result: %O',
        sessionLogId,
        toolName,
        executionTime,
        result,
      );

      // Complete or fail the toolCalling operation
      if (toolOperationId) {
        if (isSuccess) {
          context.get().completeOperation(toolOperationId);
        } else {
          context.get().failOperation(toolOperationId, {
            type: 'ToolExecutionError',
            message: result?.error || 'Tool execution failed',
          });
        }
      }

      events.push({ id: chatToolPayload.id, result, type: 'tool_result' });

      // Get latest messages from store (already updated by internal_invokeDifferentTypePlugin)
      const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];

      const newState = { ...state, messages: updatedMessages };

      // Get tool unit price
      const toolCost = TOOL_PRICING[toolName] || 0;

      // Use UsageCounter to accumulate tool usage
      const { usage, cost } = UsageCounter.accumulateTool({
        cost: state.cost,
        executionTime,
        success: isSuccess,
        toolCost,
        toolName,
        usage: state.usage,
      });

      newState.usage = usage;
      if (cost) newState.cost = cost;

      // Find current tool statistics
      const currentToolStats = usage.tools.byTool.find((t) => t.name === toolName);

      // Log usage
      log(
        '[%s][tool usage] %s: calls=%d, time=%dms, success=%s, cost=$%s',
        sessionLogId,
        toolName,
        currentToolStats?.calls || 0,
        executionTime,
        isSuccess,
        toolCost.toFixed(4),
      );

      // Check if tool wants to stop execution flow
      if (result?.stop) {
        log('[%s][call_tool] Tool returned stop=true, state: %O', sessionLogId, result.state);

        const stateType = result.state?.type;

        // Legacy agent-invocation dispatches need to be forwarded to the Agent
        // runtime as exec_sub_agent / exec_sub_agents instructions. This covers
        // server-side callAgent task states plus the desktop client-side variants.
        const legacyAgentInvocationStateTypes = [
          'execSubAgent',
          'execSubAgents',
          'execClientSubAgent',
          'execClientSubAgents',
        ];
        if (legacyAgentInvocationStateTypes.includes(stateType)) {
          log(
            '[%s][call_tool] Detected %s state, passing to Agent for decision',
            sessionLogId,
            stateType,
          );

          return {
            events,
            newState,
            nextContext: {
              payload: {
                data: result,
                executionTime,
                isSuccess,
                parentMessageId: toolMessageId,
                stop: true,
                toolCall: chatToolPayload,
                toolCallId: chatToolPayload.id,
              } as GeneralAgentCallToolResultPayload,
              phase: 'tool_result',
              session: {
                eventCount: events.length,
                messageCount: newState.messages.length,
                sessionId: state.operationId,
                status: 'running',
                stepCount: state.stepCount + 1,
              },
              stepUsage: {
                cost: toolCost,
                toolName,
                unitPrice: toolCost,
                usageCount: 1,
              },
            } as AgentRuntimeContext,
          };
        }

        // Other stop types (speak, delegate, broadcast, etc.) - stop execution immediately
        newState.status = 'done';

        return {
          events,
          newState,
          nextContext: undefined,
        };
      }

      log('[%s][call_tool] Tool execution completed', sessionLogId);

      return {
        events,
        newState,
        nextContext: {
          payload: {
            data: result,
            executionTime,
            isSuccess,
            parentMessageId: toolMessageId,
            toolCall: chatToolPayload,
            toolCallId: chatToolPayload.id,
          } as GeneralAgentCallToolResultPayload,
          phase: 'tool_result',
          session: {
            eventCount: events.length,
            messageCount: newState.messages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
          stepUsage: {
            cost: toolCost,
            toolName,
            unitPrice: toolCost,
            usageCount: 1,
          },
        } as AgentRuntimeContext,
      };
    } catch (error) {
      log('[%s][call_tool] ERROR: Tool execution failed: %O', sessionLogId, error);

      events.push({ error, type: 'error' });

      // Return current state on error (no state change)
      return { events, newState: state };
    }
  };
};
