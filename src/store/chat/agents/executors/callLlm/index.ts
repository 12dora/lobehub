import type {
  AgentInstructionCallLlm,
  GeneralAgentCallLLMInstructionPayload,
  InstructionExecutor,
} from '@lobechat/agent-runtime';

import type { AgentExecutorContext } from '../shared';
import { log } from '../shared';
import { buildCallLlmResult } from './buildResult';
import { prepareAssistantMessage } from './prepareAssistantMessage';
import { resolveCallLlmRuntime } from './resolveRuntime';
import { runAssistantMessageStream } from './runStream';
import { createCallLlmStreamingHandler } from './streamingHandler';
import type { CallLlmStreamOutcome, SkipCreateMessageLatch } from './types';

/** Creates assistant messages and streams LLM responses. */
export const createCallLlmExecutor = (context: AgentExecutorContext): InstructionExecutor => {
  const skipCreateMessage: SkipCreateMessageLatch = { value: context.skipCreateFirstMessage };

  return async (instruction, state, runtimeContext) => {
    const sessionLogId = `${state.operationId}:${state.stepCount}`;
    const stagePrefix = `[${sessionLogId}][call_llm]`;

    const llmPayload = (instruction as AgentInstructionCallLlm)
      .payload as GeneralAgentCallLLMInstructionPayload;

    log(
      `${stagePrefix} Starting session. Input: state.messages=%d, llmPayload.messages=%d, messageKey=%s`,
      state.messages.length,
      llmPayload.messages.length,
      context.messageKey,
    );

    // Only the create path is a promise — see prepareAssistantMessage on why the skip path
    // must not cost a microtask here.
    const prepared = prepareAssistantMessage({ context, llmPayload, skipCreateMessage });
    const assistantMessageId = typeof prepared === 'string' ? prepared : await prepared;

    log(`${stagePrefix} Created assistant message, id: %s`, assistantMessageId);

    log(
      `${stagePrefix} calling model-runtime chat (model: %s, messages: %d, tools: %d)`,
      llmPayload.model,
      llmPayload.messages.length,
      llmPayload.tools?.length ?? 0,
    );

    // ======== Inlined streaming logic (previously internal_fetchAIChatMessage) ========
    const runtime = resolveCallLlmRuntime({ context, runtimeContext, stagePrefix });

    const outcome: CallLlmStreamOutcome = {};

    const handler = createCallLlmStreamingHandler({ assistantMessageId, context, runtime });

    await runAssistantMessageStream({
      assistantMessageId,
      context,
      handler,
      llmPayload,
      outcome,
      runtime,
      runtimeContext,
    });

    return buildCallLlmResult({
      assistantMessageId,
      context,
      handler,
      llmPayload,
      outcome,
      sessionLogId,
      stagePrefix,
      state,
    });
  };
};
