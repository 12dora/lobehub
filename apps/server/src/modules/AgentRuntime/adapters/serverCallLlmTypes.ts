import type { AgentEvent, AgentState, CallLLMPayload } from '@lobechat/agent-runtime';
import type { ChatStreamPayload, ModelRuntime } from '@lobechat/model-runtime';
import type {
  ChatImageItem,
  ChatToolPayload,
  GroundingSearch,
  MessageToolCall,
  ModelPerformance,
  ModelReasoning,
  ModelUsage,
} from '@lobechat/types';

import type { RuntimeExecutorContext } from '../context';
import type { ServerCallLlmTooling } from './serverCallLlmTooling';

export interface ExtendedCallLLMPayload extends CallLLMPayload {
  assistantMessageId?: string;
  parentMessageId?: string;
}

export interface ServerCallLlmAttemptState {
  answerSalvagedFromReasoning: boolean;
  capturedReasoning?: ModelReasoning;
  finishReason?: string;
  grounding: GroundingSearch | null;
  imageList: ChatImageItem[];
  speed?: ModelPerformance;
  streamError?: unknown;
  toolCalls: MessageToolCall[];
  toolsCalling: ChatToolPayload[];
  usage?: ModelUsage;
}

export interface ServerCallLlmExecutionInput {
  assistantMessageId: string;
  chatPayload: ChatStreamPayload;
  ctx: RuntimeExecutorContext;
  events: AgentEvent[];
  llmPayload: CallLLMPayload;
  maxAttempts: number;
  model: string;
  modelRuntime: ModelRuntime;
  operationLogId: string;
  provider: string;
  shouldReplayAssistantReasoning: boolean;
  stagePrefix: string;
  state: AgentState;
  stepLabel?: string;
  tooling: ServerCallLlmTooling;
}
