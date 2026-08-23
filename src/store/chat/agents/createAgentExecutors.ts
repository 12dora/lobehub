import './executors/dependencies';

import type { AgentInstruction, InstructionExecutor } from '@lobechat/agent-runtime';
import type { ToolsEngine } from '@lobechat/context-engine';
import type { MessageMetadata } from '@lobechat/types';

import type { ResolvedAgentConfig } from '@/services/chat/mecha';
import type { ChatStore } from '@/store/chat/store';

import { createCallLlmExecutor } from './executors/callLlm';
import { createCallToolExecutor } from './executors/callTool';
import { createCompressContextExecutor } from './executors/compressContext';
import { createExecSubAgentExecutor } from './executors/execSubAgent';
import { createExecSubAgentsExecutor } from './executors/execSubAgents';
import { createFinishExecutor } from './executors/finish';
import { createRequestHumanApproveExecutor } from './executors/requestHumanApprove';
import { createResolveAbortedToolsExecutor } from './executors/resolveAbortedTools';
import { createAgentExecutorContext } from './executors/shared';

/**
 * Creates custom executors for the Chat Agent Runtime
 * These executors wrap existing chat store methods to integrate with agent-runtime
 *
 * @param context.operationId - Operation ID to get business context (agentId, topicId, etc.)
 * @param context.get - Store getter function
 * @param context.messageKey - Message map key
 * @param context.parentId - Parent message ID
 * @param context.skipCreateFirstMessage - Skip first message creation
 */
export const createAgentExecutors = (context: {
  /** Pre-resolved agent config with isSubAgent filtering applied */
  agentConfig: ResolvedAgentConfig;
  get: () => ChatStore;
  metadata?: Pick<MessageMetadata, 'trigger'>;
  messageKey: string;
  operationId: string;
  parentId: string;
  skipCreateFirstMessage?: boolean;
  /** ToolsEngine for expanding dynamically activated tools */
  toolsEngine?: ToolsEngine;
}) => {
  const executorContext = createAgentExecutorContext(context);
  const executors: Partial<Record<AgentInstruction['type'], InstructionExecutor>> = {
    call_llm: createCallLlmExecutor(executorContext),
    call_tool: createCallToolExecutor(executorContext),
    request_human_approve: createRequestHumanApproveExecutor(executorContext),
    resolve_aborted_tools: createResolveAbortedToolsExecutor(executorContext),
    finish: createFinishExecutor(executorContext),
    exec_sub_agent: createExecSubAgentExecutor(executorContext),
    exec_sub_agents: createExecSubAgentsExecutor(executorContext),
    compress_context: createCompressContextExecutor(executorContext),
  };

  return executors;
};
