import type { PlatformIdentityProviderDraft } from '@lobechat/types';

import type {
  IdentityProviderStep,
  IdentityProviderStepState,
} from './IdentityProviderWizardNavigation';
import type { EditableDraft } from './steps';

export const computeIdentityProviderStepStates = ({
  discovery,
  draft,
  jsonErrorsClaims,
  networkValid,
  providerSecretConfigured,
  providerStatus,
  secret,
  testResultData,
}: {
  discovery: unknown;
  draft: Pick<EditableDraft, 'clientId' | 'displayName' | 'issuer' | 'providerKey'>;
  jsonErrorsClaims: boolean;
  networkValid: boolean;
  providerSecretConfigured: boolean | undefined;
  providerStatus: PlatformIdentityProviderDraft['status'] | undefined;
  secret: string;
  testResultData: { status?: string } | null | undefined;
}): Partial<Record<IdentityProviderStep, IdentityProviderStepState>> => {
  const basicComplete = Boolean(draft.displayName.trim() && draft.providerKey.trim());
  const discoveryComplete = Boolean(draft.issuer && networkValid && discovery);
  const clientComplete = Boolean(draft.clientId && (secret || providerSecretConfigured));
  const claimsComplete = !jsonErrorsClaims;
  return {
    basic: basicComplete ? 'complete' : 'pending',
    claims: jsonErrorsClaims ? 'error' : claimsComplete ? 'complete' : 'pending',
    client: clientComplete ? 'complete' : 'pending',
    discovery: discoveryComplete ? 'complete' : 'pending',
    policy: 'complete',
    publish:
      providerStatus === 'published' ||
      providerStatus === 'active' ||
      providerStatus === 'pending_restart'
        ? 'complete'
        : testResultData?.status === 'failed'
          ? 'error'
          : 'pending',
  };
};
