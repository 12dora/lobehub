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

export const isEvaluated = (
  decision: ModerationDecision,
): decision is ModerationDecisionEvaluated => !decision.skipped;

export const fireAndForget = (
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

const throwBlocked = (
  decision: ModerationDecisionEvaluated,
  snapshot: ModerationSnapshot | null | undefined,
  recordId: string,
): never => {
  const showCategoryToUser = snapshot?.config?.messages?.showCategoryToUser !== false;
  const blockMessage = trimMessage(snapshot?.config?.messages?.blockMessage);
  const category = pickCategory(decision, showCategoryToUser);
  throw new ContentModerationBlockedError({
    recordId,
    ...(blockMessage ? { message: blockMessage } : {}),
    ...(category ? { category } : {}),
  });
};

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

export interface ModerationInterceptHelpers {
  createRecordId: () => string;
  evaluateCall: (input: ModerationEvaluateInput) => Promise<ModerationDecision>;
  extractChat: (payload: unknown) => string | null;
  extractGeneration: (payload: unknown) => string | null;
  logger: NonNullable<ModerationRuntimeDeps['logger']>;
  recordDecision: (decision: ModerationDecision, recordCtx: ModerationRecordContext) => void;
}

type CallContext = ReturnType<typeof readCallContext>;

type Gate =
  | { kind: 'bypass' }
  | {
      call: CallContext;
      decision: ModerationDecisionEvaluated;
      kind: 'evaluated';
      snapshot: ModerationSnapshot | null | undefined;
      text: string;
    }
  | {
      decidedBlock?: ModerationDecisionEvaluated;
      kind: 'fail-open';
      snapshot: ModerationSnapshot | null | undefined;
    };

const runEvaluateGate = async ({
  ctx,
  deps,
  extract,
  helpers,
  label,
  onEvaluated,
  options,
  payload,
  requestKind,
  treatAsDecidedBlock,
}: {
  ctx: WrapModelRuntimeContext;
  deps: ModerationRuntimeDeps;
  extract: (payload: unknown) => string | null;
  helpers: ModerationInterceptHelpers;
  label: string;
  onEvaluated?: (
    gate: Extract<Gate, { kind: 'evaluated' }>,
    markDecidedBlock: () => void,
  ) => void | Promise<void>;
  options: unknown;
  payload: { model: string };
  requestKind: 'chat' | 'image' | 'video';
  treatAsDecidedBlock: (decision: ModerationDecisionEvaluated) => boolean;
}): Promise<Gate> => {
  let decidedBlock: ModerationDecisionEvaluated | undefined;
  let snapshot: ModerationSnapshot | null | undefined;

  try {
    snapshot = deps.getSnapshot ? await deps.getSnapshot(ctx.db) : undefined;
    if (snapshotBypasses(snapshot)) return { kind: 'bypass' };

    const text = extract(payload);
    if (!text) return { kind: 'bypass' };

    const call = readCallContext(options);
    const decision = await helpers.evaluateCall({
      messageId: call.messageId,
      model: payload.model,
      provider: ctx.provider,
      requestId: call.requestId,
      requestKind,
      snapshot,
      text,
      topicId: call.topicId,
      userId: ctx.userId,
    });

    if (!isEvaluated(decision)) return { kind: 'bypass' };

    if (treatAsDecidedBlock(decision)) decidedBlock = decision;

    const evaluated: Extract<Gate, { kind: 'evaluated' }> = {
      call,
      decision,
      kind: 'evaluated',
      snapshot,
      text,
    };

    await onEvaluated?.(evaluated, () => {
      decidedBlock = decision;
    });

    return evaluated;
  } catch (error) {
    if (error instanceof ContentModerationBlockedError) throw error;
    if (decidedBlock) {
      throwBlocked(decidedBlock, snapshot, decidedBlock.recordId || helpers.createRecordId());
    }
    helpers.logger.error(`${label} moderation failed; failing open`, {
      code: toClassifierErrorCode(error),
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return { decidedBlock, kind: 'fail-open', snapshot };
  }
};

const planChatModeration = async (
  payload: ChatStreamPayload,
  options: ChatMethodOptions | undefined,
  ctx: WrapModelRuntimeContext,
  deps: ModerationRuntimeDeps,
  helpers: ModerationInterceptHelpers,
): Promise<ChatPlan> => {
  let plan: ChatPlan = { type: 'passthrough' };

  const gate = await runEvaluateGate({
    ctx,
    deps,
    extract: helpers.extractChat,
    helpers,
    label: 'chat',
    onEvaluated: async ({ call, decision, snapshot, text }, markDecidedBlock) => {
      const recordId = decision.recordId || helpers.createRecordId();
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
        helpers.recordDecision(decision, recordCtx);
        plan = { decision, recordId, snapshot, type: 'block' };
      } else if (decision.effectiveAction === 'downgrade') {
        const target = decision.downgradeTarget;
        if (!target?.provider || !target.model) {
          markDecidedBlock();
          helpers.recordDecision(decision, recordCtx);
          plan = { decision, recordId, snapshot, type: 'block' };
        } else {
          const showCategoryToUser = snapshot?.config?.messages?.showCategoryToUser !== false;
          const downgradeMessage = trimMessage(snapshot?.config?.messages?.downgradeMessage);
          const category = pickCategory(decision, showCategoryToUser);
          const marker: ModerationDowngradeMarker = {
            action: 'downgrade',
            model: target.model,
            originalModel: payload.model,
            originalProvider: ctx.provider,
            provider: target.provider,
            recordId,
            ...(category ? { category } : {}),
            ...(downgradeMessage ? { message: downgradeMessage } : {}),
          };
          helpers.recordDecision(decision, {
            ...recordCtx,
            effectiveModel: target.model,
            effectiveProvider: target.provider,
          });
          const nextRuntime =
            target.provider === ctx.provider ? undefined : await deps.initRuntime(target.provider);
          plan = { marker, nextRuntime, recordId, snapshot, target, type: 'downgrade' };
        }
      } else {
        helpers.recordDecision(decision, recordCtx);
        plan = { type: 'passthrough' };
      }
    },
    options,
    payload,
    requestKind: 'chat',
    treatAsDecidedBlock: isUserFacingBlock,
  });

  if (gate.kind === 'fail-open' || gate.kind === 'bypass') return { type: 'passthrough' };
  return plan;
};

const executeChatPlan = async (
  plan: ChatPlan,
  runtime: ModelRuntime,
  payload: ChatStreamPayload,
  options: ChatMethodOptions | undefined,
  deps: ModerationRuntimeDeps,
  logger: NonNullable<ModerationRuntimeDeps['logger']>,
): Promise<Response> => {
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

export const interceptChat = async (
  payload: ChatStreamPayload,
  options: ChatMethodOptions | undefined,
  runtime: ModelRuntime,
  ctx: WrapModelRuntimeContext,
  deps: ModerationRuntimeDeps,
  helpers: ModerationInterceptHelpers,
): Promise<Response> => {
  const plan = await planChatModeration(payload, options, ctx, deps, helpers);
  return executeChatPlan(plan, runtime, payload, options, deps, helpers.logger);
};

export const interceptGeneration = async <
  TPayload extends CreateImagePayload | CreateVideoPayload,
  TOptions extends CreateImageMethodOptions | CreateVideoMethodOptions | undefined,
  TResult,
>(
  requestKind: 'image' | 'video',
  payload: TPayload,
  options: TOptions,
  forward: (payload: TPayload, options: TOptions) => Promise<TResult>,
  ctx: WrapModelRuntimeContext,
  deps: ModerationRuntimeDeps,
  helpers: ModerationInterceptHelpers,
): Promise<TResult> => {
  let blocked:
    | {
        decision: ModerationDecisionEvaluated;
        recordId: string;
        snapshot: ModerationSnapshot | null | undefined;
      }
    | undefined;

  const gate = await runEvaluateGate({
    ctx,
    deps,
    extract: helpers.extractGeneration,
    helpers,
    label: requestKind,
    onEvaluated: ({ call, decision, snapshot, text }) => {
      const recordId = decision.recordId || helpers.createRecordId();
      helpers.recordDecision(decision, {
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

      if (shouldBlockGeneration(decision)) blocked = { decision, recordId, snapshot };
    },
    options,
    payload,
    requestKind,
    treatAsDecidedBlock: shouldBlockGeneration,
  });

  if (gate.kind === 'fail-open') return forward(payload, options);
  if (blocked) throwBlocked(blocked.decision, blocked.snapshot, blocked.recordId);
  return forward(payload, options);
};
