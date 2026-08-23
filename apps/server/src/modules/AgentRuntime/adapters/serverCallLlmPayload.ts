import type { AgentInstruction, CallLLMPayload } from '@lobechat/agent-runtime';
import type { ChatStreamPayload } from '@lobechat/model-runtime';
import { pickString } from '@lobechat/utils/object';

import type { ExtendedCallLLMPayload } from './serverCallLlmTypes';

export const resolveCallLlmParentId = (
  payload: CallLLMPayload,
  preparedParentId?: string,
): string | undefined => {
  const extendedPayload: ExtendedCallLLMPayload = payload;
  return preparedParentId ?? payload.parentId ?? pickString(extendedPayload.parentMessageId);
};

export const resolveAssistantMessageId = (payload: CallLLMPayload): string | undefined => {
  const extendedPayload: ExtendedCallLLMPayload = payload;
  return pickString(extendedPayload.assistantMessageId);
};

export const resolveCallLlmStepLabel = (
  instruction: AgentInstruction,
  preparedStepLabel?: string,
): string | undefined => {
  const instructionWithLabel: AgentInstruction & { stepLabel?: unknown } = instruction;
  return preparedStepLabel ?? pickString(instructionWithLabel.stepLabel);
};

export const buildServerChatPayload = ({
  messages,
  model,
  preserveThinking,
  resolvedExtendParams,
  stream,
  tools,
}: {
  messages: ChatStreamPayload['messages'];
  model: string;
  preserveThinking?: boolean;
  resolvedExtendParams: Partial<ChatStreamPayload>;
  stream: boolean;
  tools: ChatStreamPayload['tools'];
}): ChatStreamPayload => ({
  messages,
  model,
  stream,
  tools,
  // ModelExtendParams keeps provider-specific effort/thinking values as loose
  // strings (e.g. hy3's 'no_think'); the runtime payload narrows them, so cast.
  ...resolvedExtendParams,
  ...(typeof preserveThinking === 'boolean' && { preserveThinking }),
});
