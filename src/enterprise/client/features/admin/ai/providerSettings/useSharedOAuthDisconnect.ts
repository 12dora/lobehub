'use client';

import { confirmModal, toast } from '@lobehub/ui/base-ui';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { notifyAdminAiInfraError } from '@/enterprise/client/services/adminAiInfraAdapter/errors';
import { lambdaClient } from '@/libs/trpc/client';

/** Audit reason recorded for the reauth-gated withdrawal of the shared account. */
const DISCONNECT_REASON = 'admin shared provider account disconnect';

interface UseSharedOAuthDisconnectOptions {
  name: string;
  /** Revalidation fan-out of the write; it never rejects. */
  onStored: () => Promise<void>;
  providerId: string;
}

/**
 * Withdraw the shared account. Confirmation is mandatory: unlike the user-side disconnect
 * (one person, self-serve reconnect) this removes the credential EVERY member is using and
 * turns the provider off, and members have no way to restore it themselves.
 */
export const useSharedOAuthDisconnect = ({
  name,
  onStored,
  providerId,
}: UseSharedOAuthDisconnectOptions) => {
  const { t } = useTranslation('admin');
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(() => {
    confirmModal({
      cancelText: t('cancel', { ns: 'common' }),
      content: t('aiProviderSettings.sharedOAuth.disconnectConfirm', { name }),
      okButtonProps: { danger: true },
      okText: t('aiProviderSettings.sharedOAuth.disconnect'),
      onOk: async () => {
        setDisconnecting(true);
        try {
          // Same reauth handling as connect: the step-up prompt replays the SAME call.
          await withAdminReauthRetry(() =>
            lambdaClient.admin.aiProviderOAuth.disconnect.mutate({
              id: providerId,
              reason: DISCONNECT_REASON,
            }),
          );
          // The write is already committed site-wide; onStored never rejects, so a
          // failing revalidation cannot be reported as a failed disconnect.
          await onStored();
          toast.success(t('aiProviderSettings.sharedOAuth.disconnectSuccess'));
        } catch (error) {
          // Shared enterprise-error mapping (reauth cancelled/blocked, rate limit, mapped
          // codes) with a disconnect-specific fallback instead of the generic "save failed".
          notifyAdminAiInfraError(error, 'aiProviderSettings.sharedOAuth.disconnectFailed');
          // Rethrow: base-ui keeps a rejected confirm open, so the operator can retry
          // without re-reading the consequences.
          throw error;
        } finally {
          setDisconnecting(false);
        }
      },
      title: t('aiProviderSettings.sharedOAuth.disconnect'),
    });
  }, [name, onStored, providerId, t]);

  return { disconnecting, handleDisconnect };
};
