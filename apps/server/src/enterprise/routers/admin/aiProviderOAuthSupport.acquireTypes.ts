import type { BrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import type { z } from 'zod';

import type {
  adminAiProviderOAuthPollInputSchema,
  adminAiProviderOAuthPollOutputSchema,
} from '../../contracts/aiProviderOAuth';
import type { ChatGPTWebOAuthService } from '../../services/chatgptWeb/oauthService';
import type { PlatformAuditService } from '../../services/platformAudit';
import type { RotatingOAuthProviderCard } from './aiProviderOAuthSupport.card';
import type { SharedConnectionTokens } from './aiProviderOAuthSupport.vault';

export type AdminAiProviderOAuthPollInput = z.infer<typeof adminAiProviderOAuthPollInputSchema>;
export type AdminAiProviderOAuthPollOutput = z.infer<typeof adminAiProviderOAuthPollOutputSchema>;

export const unfinishedPollResult = { error: null, revision: null, stored: false };

export interface AcquireSharedConnectionParams {
  actorUserId: string;
  audit: PlatformAuditService;
  browserProfile?: BrowserDeviceProfile;
  card: RotatingOAuthProviderCard;
  existingDeviceId?: string;
  input: AdminAiProviderOAuthPollInput;
  targetId: string;
}

export type AcquireSharedConnectionOutcome =
  | { kind: 'result'; result: AdminAiProviderOAuthPollOutput }
  | {
      browserSession?: ChatGPTWebOAuthService;
      kind: 'tokens';
      tokens: SharedConnectionTokens;
    };
