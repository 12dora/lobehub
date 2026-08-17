import { type ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { AGENT_RUNTIME_ERROR_SET } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  createTraceOptions,
  initModelRuntimeFromDB,
  readConversationSourceFromRequest,
  resolveModelRuntimeConversation,
} from '@/server/modules/ModelRuntime';
import { type ChatStreamPayload } from '@/types/openai/chat';
import { createErrorResponse } from '@/utils/errorResponse';
import { getTracePayload } from '@/utils/trace';

import { resolveValidWorkspaceIdFromRequest } from '../../_utils/workspace';

// If user don't use fluid compute, will build  failed
// this enforce user to enable fluid compute
export const maxDuration = 300;

export const POST = checkAuth(async (req: Request, { params, userId, serverDB }) => {
  const provider = (await params)!.provider!;

  try {
    const workspaceId = await resolveValidWorkspaceIdFromRequest({ req, serverDB, userId });
    const tracePayload = getTracePayload(req);

    // ============  1. init chat model   ============ //
    /**
     * The CLI-shaped runtimes (Grok, Cursor) present ONE upstream session per AIHub
     * conversation, derived from the topic id and the topic's `createdAt` so every
     * replica agrees (see `conversationIdentity.ts`). It is a THUNK: the seam calls it
     * only after it knows the runtime provider, so ChatGPT Web and every ordinary
     * provider pay no lookup, while a custom provider running on the Grok/Cursor SDK
     * still gets a real conversation identity.
     */
    const modelRuntime = await initModelRuntimeFromDB(serverDB, userId, provider, workspaceId, {
      resolveConversation: () =>
        resolveModelRuntimeConversation({
          db: serverDB,
          userId,
          workspaceId,
          ...readConversationSourceFromRequest(req, tracePayload),
        }),
    });

    // ============  2. create chat completion   ============ //

    const data = (await req.json()) as ChatStreamPayload;

    let traceOptions = {};
    // If user enable trace
    if (tracePayload?.enabled) {
      traceOptions = createTraceOptions(data, { provider, trace: tracePayload });
    }

    return await modelRuntime.chat(data, {
      user: userId,
      ...traceOptions,
      signal: req.signal,
    });
  } catch (e) {
    // B2 ↔ B5: block body is `{ message, category?, recordId }` — do not wrap it
    // in the generic `{ error, provider, ... }` envelope used for other runtime errors.
    if (
      e &&
      typeof e === 'object' &&
      (e as { errorType?: unknown }).errorType ===
        PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED
    ) {
      const blocked = e as { category?: string; message?: string; recordId?: string };
      return createErrorResponse(
        PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED as ChatCompletionErrorPayload['errorType'],
        {
          ...(blocked.message ? { message: blocked.message } : {}),
          ...(blocked.category ? { category: blocked.category } : {}),
          ...(blocked.recordId ? { recordId: blocked.recordId } : {}),
        },
      );
    }

    const {
      errorType = ChatErrorType.InternalServerError,
      error: errorContent,
      ...res
    } = e as ChatCompletionErrorPayload;

    const error = errorContent || e;

    const logMethod = AGENT_RUNTIME_ERROR_SET.has(errorType as string) ? 'warn' : 'error';
    // track the error at server side
    // eslint-disable-next-line no-console
    console[logMethod](`Route: [${provider}] ${errorType}:`, error);

    return createErrorResponse(errorType, { error, ...res, provider });
  }
});
