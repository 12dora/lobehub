import { withReauth } from '@/enterprise/client/services/adminAiInfraAdapter/shared';
import { lambdaClient } from '@/libs/trpc/client';

import type { SharedOAuthPastePayload } from './sharedOAuthFlowTypes';

/** Audit reason recorded for the reauth-gated store step. */
const CONNECT_REASON = 'admin shared provider account connect';

/**
 * The two writes the shared-account flow performs, both reauth-gated: `withReauth` replays the
 * SAME call after a step-up prompt rather than restarting the flow the operator already
 * completed — which is why the device code has to be passed in rather than re-requested.
 */
export const initiateSharedOAuthDeviceCode = (providerId: string) =>
  withReauth(() =>
    lambdaClient.admin.aiProviderOAuth.initiateDeviceCode.mutate({ id: providerId }),
  );

export const pollSharedOAuthAuthStatus = (
  providerId: string,
  deviceCode: string,
  payload?: SharedOAuthPastePayload,
) =>
  withReauth(() =>
    lambdaClient.admin.aiProviderOAuth.pollAuthStatus.mutate({
      deviceCode,
      id: providerId,
      reason: CONNECT_REASON,
      ...payload,
    }),
  );
