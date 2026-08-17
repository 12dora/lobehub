import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { DINGTALK_ALLOWED_CORPS_MAX } from '@lobechat/types';
import type { TFunction } from 'i18next';

export const resolveDingTalkCaptureBlockedReason = (
  {
    canTest,
    capturePending,
    corpCount,
    dirty,
    draftWorkflowReady,
    provider,
  }: {
    canTest: boolean;
    capturePending: boolean;
    corpCount: number;
    dirty: boolean;
    draftWorkflowReady: boolean;
    provider: PlatformIdentityProviderDraft | undefined;
  },
  t: TFunction<'admin'>,
): string | null => {
  if (!provider) {
    return t('identityProviders.dingtalk.allowedCorps.blockedUnsaved');
  }
  if (!draftWorkflowReady) {
    return t('identityProviders.dingtalk.allowedCorps.blockedNotDraft');
  }
  if (!provider.clientId || !provider.secret.configured) {
    return t('identityProviders.dingtalk.allowedCorps.blockedNoCredentials');
  }
  if (dirty) {
    return t('identityProviders.dingtalk.allowedCorps.blockedUnsavedChanges');
  }
  if (!canTest) {
    return t('identityProviders.dingtalk.allowedCorps.blockedNoPermission');
  }
  // One attempt at a time: a second launch would overwrite `attempt` and orphan
  // the first DingTalk window's result.
  if (capturePending) {
    return t('identityProviders.dingtalk.allowedCorps.blockedPending');
  }
  if (corpCount >= DINGTALK_ALLOWED_CORPS_MAX) {
    return t('identityProviders.dingtalk.allowedCorps.blockedFull', {
      max: DINGTALK_ALLOWED_CORPS_MAX,
    });
  }
  return null;
};
