import type {
  AgentEvent,
  AgentInstructionExecSubAgent,
  AgentRuntimeContext,
  InstructionExecutor,
  SubAgentResultPayload,
  SubAgentTask,
} from '@lobechat/agent-runtime';

import { aiAgentService } from '@/services/aiAgent';
import { sleep } from '@/utils/sleep';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

interface SubAgentTaskWithTarget extends SubAgentTask {
  targetAgentId?: string;
}

/** Dispatches and polls one sub-agent task. */
export const createExecSubAgentExecutor = (context: AgentExecutorContext): InstructionExecutor => {
  return async (instruction, state) => {
    const { parentMessageId, task } = (instruction as AgentInstructionExecSubAgent).payload;

    const events: AgentEvent[] = [];
    const sessionLogId = `${state.operationId}:${state.stepCount}`;

    log('[%s][exec_sub_agent] Starting execution of task: %s', sessionLogId, task.description);

    // Get context from operation
    const opContext = context.getOperationContext();
    const { agentId, topicId } = opContext;

    // Check for targetAgentId (callAgent mode)
    const targetAgentId = (task as SubAgentTaskWithTarget).targetAgentId;
    const executionAgentId = targetAgentId || agentId;

    if (!agentId || !topicId || !executionAgentId) {
      log('[%s][exec_sub_agent] No valid context, cannot execute task', sessionLogId);
      return {
        events,
        newState: state,
        nextContext: {
          payload: {
            parentMessageId,
            result: {
              error: 'No valid context available',
              success: false,
              threadId: '',
            },
          } as SubAgentResultPayload,
          phase: 'sub_agent_result',
          session: {
            messageCount: state.messages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    }

    if (targetAgentId) {
      log(
        '[%s][exec_sub_agent] callAgent mode - current agent: %s, target agent: %s',
        sessionLogId,
        agentId,
        targetAgentId,
      );
    }

    const taskLogId = `${sessionLogId}:task`;

    try {
      const resultMessageId = parentMessageId;

      // 1. Create and execute task on server
      // IMPORTANT: Use executionAgentId here (targetAgentId if in callAgent mode)
      // This ensures the task executes with the correct agent's config
      log('[%s] Using server-side execution with agentId: %s', taskLogId, executionAgentId);
      const createResult = await aiAgentService.execSubAgentTask({
        agentId: executionAgentId, // Use targetAgentId for callAgent, or current agentId for sub-agent dispatch
        instruction: task.instruction,
        parentMessageId: resultMessageId,
        title: task.description,
        topicId,
      });

      if (!createResult.success) {
        log('[%s] Failed to create task: %s', taskLogId, createResult.error);
        await context
          .get()
          .optimisticUpdateMessageContent(
            resultMessageId,
            `Task creation failed: ${createResult.error}`,
            undefined,
            { operationId: state.operationId },
          );
        return {
          events,
          newState: state,
          nextContext: {
            payload: {
              parentMessageId,
              result: {
                error: createResult.error,
                success: false,
                threadId: '',
              },
            } as SubAgentResultPayload,
            phase: 'sub_agent_result',
            session: {
              messageCount: state.messages.length,
              sessionId: state.operationId,
              status: 'running',
              stepCount: state.stepCount + 1,
            },
          } as AgentRuntimeContext,
        };
      }

      log('[%s] Task created with threadId: %s', taskLogId, createResult.threadId);

      // 2. Poll for task completion
      const pollInterval = 3000; // 3 seconds
      const maxWait = task.timeout || 1_800_000; // Default 30 minutes
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        // Check if parent operation has been cancelled
        const currentOperation = context.get().operations[state.operationId];
        if (currentOperation?.status === 'cancelled') {
          log('[%s] Operation cancelled, stopping polling', taskLogId);

          // Send interrupt request to stop the server-side task
          try {
            await aiAgentService.interruptTask({ threadId: createResult.threadId });
            log('[%s] Sent interrupt request for cancelled task', taskLogId);
          } catch (err) {
            log('[%s] Failed to interrupt cancelled task: %O', taskLogId, err);
          }

          // Update the source tool message to cancelled state.
          await context
            .get()
            .optimisticUpdateMessageContent(
              resultMessageId,
              'Task was cancelled by user.',
              undefined,
              { operationId: state.operationId },
            );

          const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
          return {
            events,
            newState: { ...state, messages: updatedMessages },
            nextContext: {
              payload: {
                parentMessageId,
                result: {
                  error: 'Operation cancelled',
                  success: false,
                  threadId: createResult.threadId,
                },
              } as SubAgentResultPayload,
              phase: 'sub_agent_result',
              session: {
                messageCount: updatedMessages.length,
                sessionId: state.operationId,
                status: 'running',
                stepCount: state.stepCount + 1,
              },
            } as AgentRuntimeContext,
          };
        }

        const status = await aiAgentService.getSubAgentTaskStatus({
          threadId: createResult.threadId,
        });

        // Update taskDetail on the source tool message if available.
        if (status.taskDetail) {
          context.get().internal_dispatchMessage(
            {
              id: resultMessageId,
              type: 'updateMessage',
              value: { taskDetail: status.taskDetail },
            },
            { operationId: state.operationId },
          );
          log('[%s] Updated source tool message with taskDetail', taskLogId);
        }

        if (status.status === 'completed') {
          log('[%s] Task completed successfully', taskLogId);
          if (status.result) {
            await context
              .get()
              .optimisticUpdateMessageContent(resultMessageId, status.result, undefined, {
                operationId: state.operationId,
              });
          }
          const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
          return {
            events,
            newState: { ...state, messages: updatedMessages },
            nextContext: {
              payload: {
                parentMessageId,
                result: {
                  result: status.result,
                  success: true,
                  threadId: createResult.threadId,
                },
              } as SubAgentResultPayload,
              phase: 'sub_agent_result',
              session: {
                messageCount: updatedMessages.length,
                sessionId: state.operationId,
                status: 'running',
                stepCount: state.stepCount + 1,
              },
            } as AgentRuntimeContext,
          };
        }

        if (status.status === 'failed') {
          // Extract error message (error is always a string in TaskStatusResult)
          const errorMessage = status.error || 'Unknown error';
          log('[%s] Task failed: %s', taskLogId, errorMessage);
          await context
            .get()
            .optimisticUpdateMessageContent(
              resultMessageId,
              `Task failed: ${errorMessage}`,
              undefined,
              { operationId: state.operationId },
            );
          const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
          return {
            events,
            newState: { ...state, messages: updatedMessages },
            nextContext: {
              payload: {
                parentMessageId,
                result: {
                  error: status.error,
                  success: false,
                  threadId: createResult.threadId,
                },
              } as SubAgentResultPayload,
              phase: 'sub_agent_result',
              session: {
                messageCount: updatedMessages.length,
                sessionId: state.operationId,
                status: 'running',
                stepCount: state.stepCount + 1,
              },
            } as AgentRuntimeContext,
          };
        }

        if (status.status === 'cancel') {
          log('[%s] Task was cancelled', taskLogId);
          // Note: Don't fail the operation here - it was cancelled intentionally
          // The source tool message update records the cancellation.
          await context
            .get()
            .optimisticUpdateMessageContent(resultMessageId, 'Task was cancelled', undefined, {
              operationId: state.operationId,
            });
          const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
          return {
            events,
            newState: { ...state, messages: updatedMessages },
            nextContext: {
              payload: {
                parentMessageId,
                result: {
                  error: 'Task was cancelled',
                  success: false,
                  threadId: createResult.threadId,
                },
              } as SubAgentResultPayload,
              phase: 'sub_agent_result',
              session: {
                messageCount: updatedMessages.length,
                sessionId: state.operationId,
                status: 'running',
                stepCount: state.stepCount + 1,
              },
            } as AgentRuntimeContext,
          };
        }

        // Still processing, wait and poll again
        await sleep(pollInterval);
      }

      // Timeout reached
      log('[%s] Task timeout after %dms', taskLogId, maxWait);

      // Try to interrupt the task that timed out
      try {
        await aiAgentService.interruptTask({ threadId: createResult.threadId });
        log('[%s] Sent interrupt request for timed out task', taskLogId);
      } catch (err) {
        log('[%s] Failed to interrupt timed out task: %O', taskLogId, err);
      }

      await context
        .get()
        .optimisticUpdateMessageContent(
          resultMessageId,
          `Task timeout after ${maxWait}ms`,
          undefined,
          { operationId: state.operationId },
        );

      const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
      return {
        events,
        newState: { ...state, messages: updatedMessages },
        nextContext: {
          payload: {
            parentMessageId,
            result: {
              error: `Task timeout after ${maxWait}ms`,
              success: false,
              threadId: createResult.threadId,
            },
          } as SubAgentResultPayload,
          phase: 'sub_agent_result',
          session: {
            messageCount: updatedMessages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    } catch (error) {
      log('[%s] Error executing task: %O', taskLogId, error);
      return {
        events,
        newState: state,
        nextContext: {
          payload: {
            parentMessageId,
            result: {
              error: error instanceof Error ? error.message : 'Unknown error',
              success: false,
              threadId: '',
            },
          } as SubAgentResultPayload,
          phase: 'sub_agent_result',
          session: {
            messageCount: state.messages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    }
  };
};
