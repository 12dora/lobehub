import type {
  ChatMethodOptions,
  ChatStreamPayload,
  CreateImageMethodOptions,
  CreateImagePayload,
  CreateVideoMethodOptions,
  CreateVideoPayload,
  ModelRuntime,
} from '@lobechat/model-runtime';

import {
  MODERATION_HEADER_ACTION_DOWNGRADE,
  MODERATION_HEADERS,
} from '@/const/platform/contentModeration';
import type { ContentModerationConfig } from '@/types/platform/contentModeration';

import { toClassifierErrorCode } from '../classifiers/types';
import { readAssistantMessageId, stashModerationDowngrade } from './agentRuntimeMetadata';
import { ContentModerationBlockedError } from './blockedError';
import { createDefaultModerationRuntimeDeps } from './defaults';
import { extractGenerationPrompt, extractPromptText } from './extract';
import type {
  ModerationDecision,
  ModerationDecisionEvaluated,
  ModerationDowngradeMarker,
  ModerationDowngradeTarget,
  ModerationEvaluateInput,
  ModerationRecordContext,
  ModerationRuntimeDeps,
  ModerationSnapshot,
  WrapModelRuntimeContext,
} from './types';

const isEvaluated = (decision: ModerationDecision): decision is ModerationDecisionEvaluated =>
  !decision.skipped;

const fireAndForget = (
  task: void | Promise<void>,
  logger: NonNullable<ModerationRuntimeDeps['logger']>,
  label: string,
) => {
  void Promise.resolve(task).catch((error) => {
    logger.error(`${label} failed`, {
      code: 'moderation_internal',
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  });
};

const DOWNGRADE_HEADER_ENCODED_MAX = 2048;

const trimMessage = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const pickCategory = (
  decision: ModerationDecisionEvaluated,
  showCategoryToUser: boolean,
): string | undefined => {
  if (!showCategoryToUser) return undefined;
  return typeof decision.topCategory === 'string' && decision.topCategory
    ? decision.topCategory
    : undefined;
};

const attachModerationHeaders = (
  response: Response,
  marker: ModerationDowngradeMarker,
): Response => {
  const headers = new Headers(response.headers);
  headers.set(MODERATION_HEADERS.ACTION, MODERATION_HEADER_ACTION_DOWNGRADE);
  headers.set(MODERATION_HEADERS.PROVIDER, marker.provider);
  headers.set(MODERATION_HEADERS.MODEL, marker.model);
  if (marker.category) headers.set(MODERATION_HEADERS.CATEGORY, marker.category);
  if (marker.recordId) headers.set(MODERATION_HEADERS.RECORD, marker.recordId);
  if (marker.message) {
    const encoded = encodeURIComponent(marker.message);
    if (encoded.length <= DOWNGRADE_HEADER_ENCODED_MAX) {
      headers.set(MODERATION_HEADERS.MESSAGE, encoded);
    }
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const readCallContext = (options: unknown) => {
  if (!options || typeof options !== 'object') {
    return { messageId: undefined, requestId: undefined, topicId: undefined };
  }
  const metadata = (options as { metadata?: Record<string, unknown> }).metadata;
  return {
    messageId: readAssistantMessageId(options),
    requestId:
      typeof metadata?.operationId === 'string'
        ? metadata.operationId
        : typeof metadata?.requestId === 'string'
          ? metadata.requestId
          : undefined,
    topicId: typeof metadata?.topicId === 'string' ? metadata.topicId : undefined,
  };
};

const snapshotBypasses = (snapshot: ModerationSnapshot | null | undefined): boolean =>
  !!snapshot && (snapshot.skipped === true || snapshot.config?.mode === 'off');

const isUserFacingBlock = (decision: ModerationDecisionEvaluated): boolean =>
  decision.effectiveAction === 'block' || decision.enforce === true;

const shouldBlockGeneration = (decision: ModerationDecisionEvaluated): boolean =>
  isUserFacingBlock(decision) || decision.effectiveAction === 'downgrade';

interface ChatPlanPassthrough {
  type: 'passthrough';
}

interface ChatPlanBlock {
  decision: ModerationDecisionEvaluated;
  recordId: string;
  snapshot: ModerationSnapshot | null | undefined;
  type: 'block';
}

interface ChatPlanDowngrade {
  marker: ModerationDowngradeMarker;
  nextRuntime?: ModelRuntime;
  recordId: string;
  snapshot: ModerationSnapshot | null | undefined;
  target: ModerationDowngradeTarget;
  type: 'downgrade';
}

type ChatPlan = ChatPlanPassthrough | ChatPlanBlock | ChatPlanDowngrade;

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

  const throwBlocked = (
    decision: ModerationDecisionEvaluated,
    snapshot: ModerationSnapshot | null | undefined,
    recordId: string,
  ): never => {
    const showCategoryToUser = snapshot?.config?.messages?.showCategoryToUser !== false;
    const blockMessage = trimMessage(snapshot?.config?.messages?.blockMessage);
    throw new ContentModerationBlockedError({
      recordId,
      ...(blockMessage ? { message: blockMessage } : {}),
      ...(pickCategory(decision, showCategoryToUser)
        ? { category: pickCategory(decision, showCategoryToUser) }
        : {}),
    });
  };

  const evaluateCall = async (input: ModerationEvaluateInput) => deps.evaluate(ctx.db, input);

  const interceptChat = async (payload: ChatStreamPayload, options?: ChatMethodOptions) => {
    let decidedBlock: ModerationDecisionEvaluated | undefined;
    let snapshot: ModerationSnapshot | null | undefined;
    let plan: ChatPlan;

    try {
      snapshot = deps.getSnapshot ? await deps.getSnapshot(ctx.db) : undefined;
      if (snapshotBypasses(snapshot)) {
        plan = { type: 'passthrough' };
      } else {
        const text = extractChat(payload);
        if (!text) {
          plan = { type: 'passthrough' };
        } else {
          const call = readCallContext(options);
          const decision = await evaluateCall({
            messageId: call.messageId,
            model: payload.model,
            provider: ctx.provider,
            requestId: call.requestId,
            requestKind: 'chat',
            text,
            topicId: call.topicId,
            userId: ctx.userId,
          });

          if (!isEvaluated(decision)) {
            plan = { type: 'passthrough' };
          } else {
            if (isUserFacingBlock(decision)) decidedBlock = decision;

            const recordId = decision.recordId || createRecordId();
            const recordCtx: ModerationRecordContext = {
              config: snapshot?.config as ContentModerationConfig | undefined,
              messageId: call.messageId,
              model: payload.model,
              provider: ctx.provider,
              recordId,
              requestId: call.requestId,
              requestKind: 'chat',
              text,
              topicId: call.topicId,
              userId: ctx.userId,
            };

            if (isUserFacingBlock(decision)) {
              recordDecision(decision, recordCtx);
              plan = { decision, recordId, snapshot, type: 'block' };
            } else if (decision.effectiveAction === 'downgrade') {
              const target = decision.downgradeTarget;
              if (!target?.provider || !target.model) {
                decidedBlock = decision;
                recordDecision(decision, recordCtx);
                plan = { decision, recordId, snapshot, type: 'block' };
              } else {
                const showCategoryToUser = snapshot?.config?.messages?.showCategoryToUser !== false;
                const downgradeMessage = trimMessage(snapshot?.config?.messages?.downgradeMessage);
                const marker: ModerationDowngradeMarker = {
                  action: 'downgrade',
                  model: target.model,
                  originalModel: payload.model,
                  originalProvider: ctx.provider,
                  provider: target.provider,
                  recordId,
                  ...(pickCategory(decision, showCategoryToUser)
                    ? { category: pickCategory(decision, showCategoryToUser) }
                    : {}),
                  ...(downgradeMessage ? { message: downgradeMessage } : {}),
                };
                recordDecision(decision, {
                  ...recordCtx,
                  effectiveModel: target.model,
                  effectiveProvider: target.provider,
                });
                const nextRuntime =
                  target.provider === ctx.provider
                    ? undefined
                    : await deps.initRuntime(target.provider);
                plan = { marker, nextRuntime, recordId, snapshot, target, type: 'downgrade' };
              }
            } else {
              recordDecision(decision, recordCtx);
              plan = { type: 'passthrough' };
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof ContentModerationBlockedError) throw error;
      if (decidedBlock) {
        throwBlocked(decidedBlock, snapshot, decidedBlock.recordId || createRecordId());
      }
      logger.error('chat moderation failed; failing open', {
        code: toClassifierErrorCode(error),
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      plan = { type: 'passthrough' };
    }

    if (plan.type === 'block') {
      throwBlocked(plan.decision, plan.snapshot, plan.recordId);
    }

    if (plan.type === 'downgrade') {
      let response: Response;
      if (plan.nextRuntime) {
        response = await plan.nextRuntime.chat({ ...payload, model: plan.target.model }, options);
      } else {
        payload.model = plan.target.model;
        response = await runtime.chat(payload, options);
      }

      stashModerationDowngrade(options, plan.marker);
      const messageId = readAssistantMessageId(options);
      if (messageId) {
        fireAndForget(deps.persistDowngrade?.(plan.marker, messageId), logger, 'persistDowngrade');
      }

      if (!(response instanceof Response)) return response;
      try {
        return attachModerationHeaders(response, plan.marker);
      } catch (error) {
        logger.error('failed to attach moderation headers', {
          code: 'moderation_internal',
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
        return response;
      }
    }

    return runtime.chat(payload, options);
  };

  const interceptGeneration = async <
    TPayload extends CreateImagePayload | CreateVideoPayload,
    TOptions extends CreateImageMethodOptions | CreateVideoMethodOptions | undefined,
    TResult,
  >(
    requestKind: 'image' | 'video',
    payload: TPayload,
    options: TOptions,
    forward: (payload: TPayload, options: TOptions) => Promise<TResult>,
  ): Promise<TResult> => {
    let decidedBlock: ModerationDecisionEvaluated | undefined;
    let snapshot: ModerationSnapshot | null | undefined;
    let blocked: { decision: ModerationDecisionEvaluated; recordId: string } | undefined;

    try {
      snapshot = deps.getSnapshot ? await deps.getSnapshot(ctx.db) : undefined;
      if (!snapshotBypasses(snapshot)) {
        const text = extractGeneration(payload);
        if (text) {
          const call = readCallContext(options);
          const decision = await evaluateCall({
            messageId: call.messageId,
            model: payload.model,
            provider: ctx.provider,
            requestId: call.requestId,
            requestKind,
            text,
            topicId: call.topicId,
            userId: ctx.userId,
          });

          if (isEvaluated(decision)) {
            const treatAsBlock = shouldBlockGeneration(decision);
            if (treatAsBlock) decidedBlock = decision;

            const recordId = decision.recordId || createRecordId();
            recordDecision(decision, {
              config: snapshot?.config as ContentModerationConfig | undefined,
              messageId: call.messageId,
              model: payload.model,
              provider: ctx.provider,
              recordId,
              requestId: call.requestId,
              requestKind,
              text,
              topicId: call.topicId,
              userId: ctx.userId,
            });

            if (treatAsBlock) blocked = { decision, recordId };
          }
        }
      }
    } catch (error) {
      if (error instanceof ContentModerationBlockedError) throw error;
      if (decidedBlock)
        throwBlocked(decidedBlock, snapshot, decidedBlock.recordId || createRecordId());
      logger.error(`${requestKind} moderation failed; failing open`, {
        code: toClassifierErrorCode(error),
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
      return forward(payload, options);
    }

    if (blocked) throwBlocked(blocked.decision, snapshot, blocked.recordId);
    return forward(payload, options);
  };

  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === 'chat') return interceptChat;
      if (prop === 'createImage') {
        return (payload: CreateImagePayload, options?: CreateImageMethodOptions) =>
          interceptGeneration('image', payload, options, (nextPayload, nextOptions) =>
            target.createImage(nextPayload, nextOptions),
          );
      }
      if (prop === 'createVideo') {
        return (payload: CreateVideoPayload, options?: CreateVideoMethodOptions) =>
          interceptGeneration('video', payload, options, (nextPayload, nextOptions) =>
            target.createVideo(nextPayload, nextOptions),
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
