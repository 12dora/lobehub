import { getProviderOAuthGrantFlow } from 'model-bank/modelProviders';

import { getOAuthService } from '@/server/services/oauthDeviceFlow/providers/githubCopilot';

import { buildChatGPTWebBrowserSessionAccountId } from '../../services/chatgptWeb/oauthService';
import { acquireDevicePollTokens } from './aiProviderOAuthSupport.acquireDevice';
import { acquireAuthorizationCodePasteTokens } from './aiProviderOAuthSupport.acquirePaste';
import type {
  AcquireSharedConnectionOutcome,
  AcquireSharedConnectionParams,
} from './aiProviderOAuthSupport.acquireTypes';

export type { AcquireSharedConnectionOutcome, AcquireSharedConnectionParams };
export { unfinishedPollResult } from './aiProviderOAuthSupport.acquireTypes';

/**
 * The device grant is single-use. This step either returns a non-terminal poll
 * result (pending / error the operator can fix) or the tokens to persist.
 */
export const acquireSharedConnectionTokens = async (
  params: AcquireSharedConnectionParams,
): Promise<AcquireSharedConnectionOutcome> => {
  const { browserProfile, input } = params;
  const oauthService = getOAuthService(
    input.id,
    browserProfile
      ? {
          browserProfile,
          browserSessionAccountId: buildChatGPTWebBrowserSessionAccountId({
            kind: 'platform',
            providerId: input.id,
          }),
        }
      : undefined,
  );

  if (getProviderOAuthGrantFlow(input.id) === 'authorization_code_paste') {
    return acquireAuthorizationCodePasteTokens({ ...params, oauthService });
  }
  return acquireDevicePollTokens({ ...params, oauthService });
};
