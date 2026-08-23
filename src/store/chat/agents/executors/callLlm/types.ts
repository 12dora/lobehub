import type { MessageToolCall, ModelUsage } from '@lobechat/types';

/**
 * Created once per `createCallLlmExecutor` call and shared by every invocation of
 * the returned executor: the first invocation that reuses an existing assistant
 * message flips it off for all later ones.
 */
export interface SkipCreateMessageLatch {
  value: boolean | undefined;
}

/**
 * Written by the stream's `onFinish` callback and read once the stream has
 * completed. One shared mutable cell, never two copies.
 */
export interface CallLlmStreamOutcome {
  toolCalls?: MessageToolCall[];
  usage?: ModelUsage;
}
