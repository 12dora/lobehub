import { type ChatCompletionErrorPayload, type PullModelParams } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import {
  getEmptyPlatformAiRuntimeState,
  isPlatformAiTakeoverActive,
  resolvePlatformAiRuntimeState,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';
import { createErrorResponse } from '@/utils/errorResponse';

import { resolveValidWorkspaceIdFromRequest } from '../../../_utils/workspace';

export const POST = checkAuth(async (req, { params, userId, serverDB }) => {
  const provider = (await params)!.provider!;

  try {
    if (await isPlatformAiTakeoverActive(serverDB)) {
      // Platform providers keep pull disabled while 平台托管 is published. User self-built /
      // BYOK providers (not in the platform catalog) — and every provider while the platform
      // has not taken over — fall through to the user runtime path.
      const platformState = await resolvePlatformAiRuntimeState({
        db: serverDB,
        upstreamState: getEmptyPlatformAiRuntimeState(),
      });
      if (platformState.enabledAiProviders.some((item) => item.id === provider)) {
        return Response.json(
          { errorType: PLATFORM_ERROR_CODES.PLATFORM_AI_MODEL_PULL_DISABLED },
          { status: 403 },
        );
      }
    }

    const workspaceId = await resolveValidWorkspaceIdFromRequest({ req, serverDB, userId });

    // Read user's provider config from database
    const agentRuntime = await initModelRuntimeFromDB(serverDB, userId, provider, workspaceId);

    const data = (await req.json()) as PullModelParams;

    const res = await agentRuntime.pullModel(data, { signal: req.signal });
    if (res) return res;

    throw new Error('No response');
  } catch (e) {
    const {
      errorType = ChatErrorType.InternalServerError,
      error: errorContent,
      ...res
    } = e as ChatCompletionErrorPayload;

    const error = errorContent || e;
    // track the error at server side
    console.error(`Route: [${provider}] ${errorType}:`, error);

    return createErrorResponse(errorType, { error, ...res, provider });
  }
});
