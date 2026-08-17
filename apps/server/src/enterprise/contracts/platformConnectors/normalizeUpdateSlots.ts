import type { z } from 'zod';

import { adminConnectorOAuthConfigInputSchema } from './common';
import type { adminConnectorDraftSchema, adminConnectorUpdateDraftInputSchema } from './draft';
import type { resolveTrustedSecretLeaves } from './secrets';
import { applySecretMutationState, clearSecretMutation, emptySecretState } from './secrets';

type ConnectorDraft = z.infer<typeof adminConnectorDraftSchema>;
type ConnectorUpdatePatch = z.infer<typeof adminConnectorUpdateDraftInputSchema>;
type CredentialMode = ConnectorDraft['credentialMode'];
type TrustedSecretLeaves = ReturnType<typeof resolveTrustedSecretLeaves>;
type CurrentOauthInput = z.input<typeof adminConnectorOAuthConfigInputSchema>;

export const resolveTargetOauthConfig = (
  current: ConnectorDraft,
  patch: ConnectorUpdatePatch,
  targetMode: CredentialMode,
  redirectUri: string | null,
) =>
  targetMode === 'per_user_oauth'
    ? patch.oauthConfig
      ? { ...patch.oauthConfig, redirectUri }
      : current.credentialMode === 'per_user_oauth'
        ? current.oauthConfig
        : null
    : null;

export const resolveSlotState = (
  slotName: 'oauthClientSecret' | 'sharedSecret',
  current: ConnectorDraft,
  patch: ConnectorUpdatePatch,
  targetMode: CredentialMode,
  switchingMode: boolean,
) =>
  slotName === 'oauthClientSecret'
    ? targetMode === 'per_user_oauth'
      ? applySecretMutationState(
          current.credentialMode === 'per_user_oauth'
            ? current.oauthClientSecret
            : emptySecretState,
          patch.oauthClientSecret,
          switchingMode,
        )
      : emptySecretState
    : targetMode === 'shared_service_account'
      ? applySecretMutationState(
          current.credentialMode === 'shared_service_account'
            ? current.sharedSecret
            : emptySecretState,
          patch.sharedSecret,
          switchingMode,
        )
      : emptySecretState;

export const expectedSlotLeaves = (
  slotName: 'oauthClientSecret' | 'sharedSecret',
  current: ConnectorDraft,
  patch: ConnectorUpdatePatch,
  targetMode: CredentialMode,
  trusted: TrustedSecretLeaves,
) =>
  slotName === 'oauthClientSecret'
    ? targetMode !== 'per_user_oauth' || patch.oauthClientSecret?.operation === 'clear'
      ? []
      : patch.oauthClientSecret?.operation === 'replace'
        ? trusted.replacement.oauthClientSecret
        : current.credentialMode === 'per_user_oauth'
          ? trusted.current.oauthClientSecret
          : []
    : targetMode !== 'shared_service_account' || patch.sharedSecret?.operation === 'clear'
      ? []
      : patch.sharedSecret?.operation === 'replace'
        ? trusted.replacement.sharedSecret
        : current.credentialMode === 'shared_service_account'
          ? trusted.current.sharedSecret
          : [];

export const projectPatchSlots = (
  patch: ConnectorUpdatePatch,
  targetMode: CredentialMode,
  currentOauthInput: CurrentOauthInput | undefined,
) => ({
  oauthClientSecret:
    targetMode === 'per_user_oauth' ? patch.oauthClientSecret : clearSecretMutation,
  oauthConfig:
    targetMode === 'per_user_oauth'
      ? (patch.oauthConfig ??
        (currentOauthInput
          ? adminConnectorOAuthConfigInputSchema.parse(currentOauthInput)
          : undefined))
      : null,
  sharedSecret: targetMode === 'shared_service_account' ? patch.sharedSecret : clearSecretMutation,
});
