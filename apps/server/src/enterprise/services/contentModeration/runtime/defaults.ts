import debug from 'debug';

import { toClassifierErrorCode } from '../classifiers/types';
import type { EvaluatedDecision, EvaluatePromptInput } from '../decisionService';
import { evaluatePrompt } from '../decisionService';
import {
  extractGenerationPrompt as extractB1GenerationPrompt,
  extractPromptText as extractB1PromptText,
} from '../normalize';
import { recordDecisionAsync } from '../recorder';
import { getModerationSnapshot } from '../settingsSnapshot';
import { persistModerationDowngradeBestEffort } from './agentRuntimeMetadata';
import type {
  ModerationDecision,
  ModerationRecordContext,
  ModerationRuntimeDeps,
  WrapModelRuntimeContext,
} from './types';

const log = debug('lobe-server:content-moderation');

const isSafeLogPayload = (value: unknown): value is { code: string; errorClass: string } =>
  Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'code' in value &&
    'errorClass' in value,
  );

const sanitizeLogArgs = (args: unknown[]): { code: string; errorClass: string } => {
  const structured = args.find(isSafeLogPayload);
  if (structured) return { code: structured.code, errorClass: structured.errorClass };
  const error = args.find((arg) => arg instanceof Error);
  if (error instanceof Error) {
    return { code: toClassifierErrorCode(error), errorClass: error.name };
  }
  return { code: 'moderation_internal', errorClass: 'UnknownError' };
};

const defaultLogger = {
  debug: (...args: unknown[]) => {
    log('%O', args);
  },
  error: (...args: unknown[]) => {
    console.error('[content-moderation]', sanitizeLogArgs(args));
  },
  warn: (...args: unknown[]) => {
    console.warn('[content-moderation]', sanitizeLogArgs(args));
  },
};

const toNullableText = (text: string): string | null => (text.trim() ? text : null);

/**
 * B1's extractor only reads `payload.prompt`. Model-runtime image/video put the
 * prompt on `params.prompt` — normalize through B1 after lifting the field.
 */
const extractGenerationPrompt = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { params?: { prompt?: unknown }; prompt?: unknown };
  const raw = typeof record.params?.prompt === 'string' ? record.params.prompt : record.prompt;
  if (typeof raw !== 'string') return null;
  return toNullableText(extractB1GenerationPrompt({ prompt: raw }));
};

const extractPromptText = (payload: unknown): string | null =>
  toNullableText(extractB1PromptText(payload));

const record = (
  db: Parameters<ModerationRuntimeDeps['record']>[0],
  ctx: ModerationRecordContext,
  decision: ModerationDecision,
) => {
  if (decision.skipped) return;
  if (!ctx.config) {
    console.error('[content-moderation] recordDecision skipped: missing snapshot config');
    return;
  }
  recordDecisionAsync(
    db,
    {
      config: ctx.config,
      messageId: ctx.messageId,
      model: ctx.model,
      provider: ctx.provider,
      recordId: ctx.recordId,
      requestId: ctx.requestId,
      requestKind: ctx.requestKind,
      text: ctx.text ?? '',
      topicId: ctx.topicId,
      userId: ctx.userId,
    },
    decision as EvaluatedDecision,
  );
};

export const createDefaultModerationRuntimeDeps = (
  ctx: WrapModelRuntimeContext,
): ModerationRuntimeDeps => {
  return {
    createRecordId: () => crypto.randomUUID(),
    // The runtime layer types the snapshot as `unknown` (its own slim ModerationSnapshot);
    // this composition root is where the full settings snapshot is handed to the decision service.
    evaluate: (db, input) =>
      evaluatePrompt(db, { ...input, snapshot: input.snapshot as EvaluatePromptInput['snapshot'] }),
    extractGenerationPrompt,
    extractPromptText,
    getSnapshot: getModerationSnapshot,
    initRuntime: async (provider) => {
      const { initModelRuntimeFromDB } = await import('@/server/modules/ModelRuntime');
      return initModelRuntimeFromDB(ctx.db, ctx.userId, provider, ctx.workspaceId, {
        skipModeration: true,
      });
    },
    logger: defaultLogger,
    now: () => new Date(),
    persistDowngrade: (marker, messageId) =>
      persistModerationDowngradeBestEffort({
        db: ctx.db,
        marker,
        messageId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      }),
    record,
  };
};
