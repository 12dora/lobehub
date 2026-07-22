import type { ChatCompletionErrorPayload } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { NextResponse } from 'next/server';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import {
  getEmptyPlatformAiRuntimeState,
  isPlatformManagedAiEnabled,
  listPlatformPublishedModels,
  resolvePlatformAiRuntimeState,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';
import { createErrorResponse } from '@/utils/errorResponse';

import { resolveValidWorkspaceIdFromRequest } from '../../_utils/workspace';

const getMessageFromError = (error: unknown): string | undefined => {
  if (error === null || error === undefined) return;
  if (typeof error === 'string') return error;

  if (error instanceof Error) {
    if (error.cause instanceof Error && error.cause.message) return error.cause.message;
    return error.message;
  }

  if (typeof error !== 'object') return;

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
};

const createModelListErrorResponse = (provider: string, e: unknown) => {
  let error = e;
  let errorType: ChatCompletionErrorPayload['errorType'] = ChatErrorType.InternalServerError;
  let rest: Partial<ChatCompletionErrorPayload> = {};

  if (e && typeof e === 'object') {
    const {
      error: errorContent,
      errorType: payloadErrorType,
      ...payloadRest
    } = e as Partial<ChatCompletionErrorPayload>;

    error = errorContent || e;
    errorType = payloadErrorType || errorType;
    rest = payloadRest;
  }

  console.error(`Route: [${provider}] ${errorType}:`, error);

  return createErrorResponse(errorType, {
    error,
    ...rest,
    message: getMessageFromError(error) || getMessageFromError(e) || rest.message,
    provider,
  });
};

export const GET = checkAuth(async (req, { params, userId, serverDB }) => {
  const provider = (await params)!.provider!;

  try {
    if (isPlatformManagedAiEnabled()) {
      // Platform catalog membership (enabled published providers). Equivalent to
      // PLATFORM_NOT_FOUND on resolve: missing/disabled providers are not listed here.
      // Platform hit → return published models (may be empty). Miss → user BYOK path.
      const platformState = await resolvePlatformAiRuntimeState({
        db: serverDB,
        upstreamState: getEmptyPlatformAiRuntimeState(),
      });
      if (platformState.enabledAiProviders.some((item) => item.id === provider)) {
        return NextResponse.json(await listPlatformPublishedModels(serverDB, provider));
      }
    }

    const workspaceId = await resolveValidWorkspaceIdFromRequest({ req, serverDB, userId });

    // Read user's provider config from database
    const agentRuntime = await initModelRuntimeFromDB(serverDB, userId, provider, workspaceId);

    const list = await agentRuntime.models();

    return NextResponse.json(list);
  } catch (e) {
    return createModelListErrorResponse(provider, e);
  }
});
