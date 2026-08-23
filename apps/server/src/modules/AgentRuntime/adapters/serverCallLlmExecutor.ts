import {
  type AgentEvent,
  type AgentInstruction,
  type CallLLMPayload,
  type InstructionExecutor,
  resolveLLMMaxAttempts,
} from '@lobechat/agent-runtime';
import { BRANDING_PROVIDER } from '@lobechat/business-const';
import type { ChatStreamPayload } from '@lobechat/model-runtime';

import type { RuntimeExecutorContext } from '../context';
import { log } from '../executorHelpers';
import { formatErrorEventData } from '../formatErrorEventData';
import {
  initOperationModelRuntime,
  resolveOperationPlatformExecution,
} from './operationModelRuntime';
import { buildServerCallLlmContext } from './serverCallLlmContextBuilder';
import { executeServerCallLlm } from './serverCallLlmExecution';
import {
  assertCallLlmParentExists,
  prepareAssistantMessage,
  publishCallLlmStreamStart,
} from './serverCallLlmMessage';
import {
  buildServerChatPayload,
  resolveCallLlmParentId,
  resolveCallLlmStepLabel,
} from './serverCallLlmPayload';
import { resolveServerCallLlmTooling, type ServerCallLlmTooling } from './serverCallLlmTooling';

export { isAnswerInThinkingSalvageFinishReason } from './serverCallLlmCompletion';

interface PreparedCallLLMContext {
  assistantMessage: { id: string };
  model: string;
  parentId?: string;
  provider: string;
  stepLabel?: string;
  tooling?: ServerCallLlmTooling;
}

const SERVER_LLM_RETRY_POLICY = {
  noRetryProviders: [BRANDING_PROVIDER],
};

const executeCallLlmInstruction = async ({
  ctx,
  instruction,
  prepared,
  state,
}: {
  ctx: RuntimeExecutorContext;
  instruction: AgentInstruction;
  prepared?: PreparedCallLLMContext;
  state: Parameters<InstructionExecutor>[1];
}): ReturnType<InstructionExecutor> => {
  const { payload } = instruction as Extract<AgentInstruction, { type: 'call_llm' }>;
  const llmPayload = payload as CallLLMPayload;
  const { operationId, stepIndex, streamManager } = ctx;
  const events: AgentEvent[] = [];
  const model = prepared?.model ?? llmPayload.model ?? state.modelRuntimeConfig?.model;
  const provider = prepared?.provider ?? llmPayload.provider ?? state.modelRuntimeConfig?.provider;
  const tooling =
    prepared?.tooling ?? resolveServerCallLlmTooling(ctx, state, llmPayload.allowedToolNames);

  if (!model || !provider) {
    throw new Error('Model and provider are required for call_llm instruction');
  }

  const operationLogId = `${operationId}:${stepIndex}`;
  const stagePrefix = `[${operationLogId}][call_llm]`;
  log(`${stagePrefix} Starting operation`);

  const parentId = resolveCallLlmParentId(llmPayload, prepared?.parentId);
  await assertCallLlmParentExists(ctx, parentId, !!prepared);
  const assistantMessage = await prepareAssistantMessage({
    ctx,
    llmPayload,
    model,
    parentId,
    preparedAssistantMessage: prepared?.assistantMessage,
    provider,
    stagePrefix,
    state,
  });
  const stepLabel = resolveCallLlmStepLabel(instruction, prepared?.stepLabel);
  if (!prepared) {
    await publishCallLlmStreamStart({ assistantMessage, ctx, model, provider, stepLabel });
  }

  try {
    const resolvedExecution = await resolveOperationPlatformExecution(ctx, provider, model, state);
    const context = await buildServerCallLlmContext({
      ctx,
      llmPayload,
      model,
      provider,
      resolvedExecution: resolvedExecution.execution,
      state,
      tooling,
    });

    // A system-only turn has nothing to respond to; Anthropic-compatible
    // providers also move system messages outside the messages array.
    if (!context.processedMessages.some((message) => message.role !== 'system')) {
      throw new Error(
        `call_llm produced no non-system messages for ${provider}/${model} ` +
          `(topic=${state.metadata?.topicId ?? 'n/a'}, step=${stepIndex}); refusing to dispatch`,
      );
    }

    const modelRuntime = await initOperationModelRuntime(ctx, provider, model, resolvedExecution);
    const chatPayload = buildServerChatPayload({
      messages: context.processedMessages,
      model,
      preserveThinking: context.preserveThinkingForPayload,
      resolvedExtendParams: context.resolvedExtendParams as Partial<ChatStreamPayload>,
      stream: ctx.stream ?? true,
      tools: tooling.tools,
    });
    return await executeServerCallLlm(
      {
        assistantMessageId: assistantMessage.item.id,
        chatPayload,
        ctx,
        events,
        llmPayload,
        maxAttempts: resolveLLMMaxAttempts(provider, SERVER_LLM_RETRY_POLICY),
        model,
        modelRuntime,
        operationLogId,
        provider,
        shouldReplayAssistantReasoning: context.shouldReplayAssistantReasoning,
        stagePrefix,
        state,
        stepLabel,
        tooling,
      },
      SERVER_LLM_RETRY_POLICY,
    );
  } catch (error) {
    await streamManager.publishStreamEvent(operationId, {
      data: formatErrorEventData(error, 'llm_execution'),
      stepIndex,
      type: 'error',
    });
    console.error(
      `[StreamingLLMExecutor][${operationId}:${stepIndex}] LLM execution failed:`,
      error,
    );
    throw error;
  }
};

export const callLlm =
  (ctx: RuntimeExecutorContext, prepared?: PreparedCallLLMContext): InstructionExecutor =>
  async (instruction, state) =>
    executeCallLlmInstruction({ ctx, instruction, prepared, state });
