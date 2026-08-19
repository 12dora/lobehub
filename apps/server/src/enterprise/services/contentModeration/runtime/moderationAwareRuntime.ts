import type {
  ChatMethodOptions,
  ChatStreamPayload,
  CreateImageMethodOptions,
  CreateImagePayload,
  CreateVideoMethodOptions,
  CreateVideoPayload,
  ModelRuntime,
} from '@lobechat/model-runtime';

import { toClassifierErrorCode } from '../classifiers/types';
import { createDefaultModerationRuntimeDeps } from './defaults';
import { extractGenerationPrompt, extractPromptText } from './extract';
import { fireAndForget, interceptChat, interceptGeneration, isEvaluated } from './intercept';
import type {
  ModerationDecision,
  ModerationEvaluateInput,
  ModerationRecordContext,
  ModerationRuntimeDeps,
  WrapModelRuntimeContext,
} from './types';

export const createModerationAwareRuntime = (
  runtime: ModelRuntime,
  ctx: WrapModelRuntimeContext,
  deps: ModerationRuntimeDeps,
): ModelRuntime => {
  if (ctx.skipModeration) return runtime;

  const logger: NonNullable<ModerationRuntimeDeps['logger']> = deps.logger ?? {
    error: (...args: unknown[]) => {
      const payload = args.find(
        (arg) => arg && typeof arg === 'object' && 'code' in arg && 'errorClass' in arg,
      ) as { code?: unknown; errorClass?: unknown } | undefined;
      const error = args.find((arg) => arg instanceof Error);
      const structured = payload
        ? { code: String(payload.code), errorClass: String(payload.errorClass) }
        : {
            code: error instanceof Error ? toClassifierErrorCode(error) : 'moderation_internal',
            errorClass: error instanceof Error ? error.name : 'UnknownError',
          };
      console.error('[content-moderation]', structured);
    },
  };
  const createRecordId = deps.createRecordId ?? (() => crypto.randomUUID());
  const extractChat = deps.extractPromptText ?? extractPromptText;
  const extractGeneration = deps.extractGenerationPrompt ?? extractGenerationPrompt;

  const recordDecision = (decision: ModerationDecision, recordCtx: ModerationRecordContext) => {
    if (isEvaluated(decision) && decision.reused) return;
    fireAndForget(deps.record(ctx.db, recordCtx, decision), logger, 'recordDecision');
  };

  const evaluateCall = async (input: ModerationEvaluateInput) => deps.evaluate(ctx.db, input);

  const helpers = {
    createRecordId,
    evaluateCall,
    extractChat,
    extractGeneration,
    logger,
    recordDecision,
  };

  const chat = (payload: ChatStreamPayload, options?: ChatMethodOptions) =>
    interceptChat(payload, options, runtime, ctx, deps, helpers);

  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chat;
      if (prop === 'createImage') {
        return (payload: CreateImagePayload, options?: CreateImageMethodOptions) =>
          interceptGeneration(
            'image',
            payload,
            options,
            (nextPayload, nextOptions) => target.createImage(nextPayload, nextOptions),
            ctx,
            deps,
            helpers,
          );
      }
      if (prop === 'createVideo') {
        return (payload: CreateVideoPayload, options?: CreateVideoMethodOptions) =>
          interceptGeneration(
            'video',
            payload,
            options,
            (nextPayload, nextOptions) => target.createVideo(nextPayload, nextOptions),
            ctx,
            deps,
            helpers,
          );
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') return value.bind(target);
      return value;
    },
  });
};

export const wrapModelRuntimeWithModeration = (
  runtime: ModelRuntime,
  ctx: WrapModelRuntimeContext,
  deps?: Partial<ModerationRuntimeDeps>,
): ModelRuntime => {
  if (ctx.skipModeration) return runtime;
  const defaults = createDefaultModerationRuntimeDeps(ctx);
  return createModerationAwareRuntime(runtime, ctx, { ...defaults, ...deps });
};
