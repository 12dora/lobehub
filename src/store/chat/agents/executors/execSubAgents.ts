import type {
  AgentEvent,
  AgentInstructionExecSubAgents,
  AgentRuntimeContext,
  InstructionExecutor,
  SubAgentsBatchResultPayload,
  SubAgentTask,
} from '@lobechat/agent-runtime';
import pMap from 'p-map';

import { aiAgentService } from '@/services/aiAgent';
import { sleep } from '@/utils/sleep';

import type { AgentExecutorContext } from './shared';
import { log } from './shared';

const formatSubAgentBatchResultContent = (
  tasks: SubAgentTask[],
  results: SubAgentsBatchResultPayload['results'],
) =>
  results
    .map((result, index) => {
      const title = tasks[index]?.description ?? `Task ${index + 1}`;
      const content = result.success
        ? (result.result ?? 'Completed successfully.')
        : `Failed: ${result.error ?? 'Unknown error'}`;

      return `${index + 1}. ${title}\n${content}`;
    })
    .join('\n\n');

/** Dispatches and polls sub-agent tasks in parallel. */
export const createExecSubAgentsExecutor = (context: AgentExecutorContext): InstructionExecutor => {
  return async (instruction, state) => {
    const { parentMessageId, tasks } = (instruction as AgentInstructionExecSubAgents).payload;

    const events: AgentEvent[] = [];
    const sessionLogId = `${state.operationId}:${state.stepCount}`;

    log('[%s][exec_sub_agents] Starting execution of %d tasks', sessionLogId, tasks.length);

    // Get context from operation
    const opContext = context.getOperationContext();
    const { agentId, topicId } = opContext;

    if (!agentId || !topicId) {
      log('[%s][exec_sub_agents] No valid context, cannot execute tasks', sessionLogId);
      return {
        events,
        newState: state,
        nextContext: {
          payload: {
            parentMessageId,
            results: tasks.map(() => ({
              error: 'No valid context available',
              success: false,
              threadId: '',
            })),
          } as SubAgentsBatchResultPayload,
          phase: 'sub_agents_batch_result',
          session: {
            messageCount: state.messages.length,
            sessionId: state.operationId,
            status: 'running',
            stepCount: state.stepCount + 1,
          },
        } as AgentRuntimeContext,
      };
    }

    // Execute all tasks in parallel
    const results = await pMap(
      tasks,
      async (task, taskIndex) => {
        const taskLogId = `${sessionLogId}:task-${taskIndex}`;
        log('[%s] Starting task: %s', taskLogId, task.description);

        try {
          const resultMessageId = parentMessageId;

          // 1. Create and execute task on server
          log('[%s] Using server-side execution', taskLogId);
          const createResult = await aiAgentService.execSubAgentTask({
            agentId,
            instruction: task.instruction,
            parentMessageId: resultMessageId,
            title: task.description,
            topicId,
          });

          if (!createResult.success) {
            log('[%s] Failed to create task: %s', taskLogId, createResult.error);
            return {
              error: createResult.error,
              success: false,
              threadId: '',
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

              return {
                error: 'Operation cancelled',
                success: false,
                threadId: createResult.threadId,
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
              return {
                result: status.result,
                success: true,
                threadId: createResult.threadId,
              };
            }

            if (status.status === 'failed') {
              const errorMessage = status.error || 'Unknown error';
              log('[%s] Task failed: %s', taskLogId, errorMessage);
              return {
                error: status.error,
                success: false,
                threadId: createResult.threadId,
              };
            }

            if (status.status === 'cancel') {
              log('[%s] Task was cancelled', taskLogId);
              // Note: Don't fail the operation here - it was cancelled intentionally
              // The aggregate result update below records the cancellation.
              return {
                error: 'Task was cancelled',
                success: false,
                threadId: createResult.threadId,
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

          return {
            error: `Task timeout after ${maxWait}ms`,
            success: false,
            threadId: createResult.threadId,
          };
        } catch (error) {
          log('[%s] Error executing task: %O', taskLogId, error);
          return {
            error: error instanceof Error ? error.message : 'Unknown error',
            success: false,
            threadId: '',
          };
        }
      },
      { concurrency: 15 }, // Limit concurrent tasks
    );

    log('[%s][exec_sub_agents] All tasks completed, results: %O', sessionLogId, results);

    await context
      .get()
      .optimisticUpdateMessageContent(
        parentMessageId,
        formatSubAgentBatchResultContent(tasks, results),
        undefined,
        { operationId: state.operationId },
      );

    // Get latest messages from store
    const updatedMessages = context.get().dbMessagesMap[context.messageKey] || [];
    const newState = { ...state, messages: updatedMessages };

    // Return sub_agents_batch_result phase
    return {
      events,
      newState,
      nextContext: {
        payload: {
          parentMessageId,
          results,
        } as SubAgentsBatchResultPayload,
        phase: 'sub_agents_batch_result',
        session: {
          messageCount: newState.messages.length,
          sessionId: state.operationId,
          status: 'running',
          stepCount: state.stepCount + 1,
        },
      } as AgentRuntimeContext,
    };
  };
};
