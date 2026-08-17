'use client';

import { confirmModal, toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import {
  AdminReauthCancelledError,
  requestAdminReauth,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminAccessContextValue } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { openReasonModal } from '../users/modals/openReasonModal';
import type { useIdentityProviderRestartLifecycle } from './useIdentityProviderRestartLifecycle';

interface UseIdentityProviderRestartActionInput {
  authMethod: AdminAccessContextValue['authMethod'];
  restartLifecycle: Pick<ReturnType<typeof useIdentityProviderRestartLifecycle>, 'accept' | 'fail'>;
  runtime: {
    data?: {
      pendingRestart?: boolean;
      restart: { supported: boolean };
    };
    mutate: () => Promise<unknown>;
  };
  t: TFunction<'admin'>;
}

export const useIdentityProviderRestartAction = ({
  authMethod,
  restartLifecycle,
  runtime,
  t,
}: UseIdentityProviderRestartActionInput) => {
  const requestRestart = () => {
    if (!runtime.data?.pendingRestart || !runtime.data.restart.supported) return;
    confirmModal({
      cancelText: t('identityProviders.restart.cancel'),
      content: t('identityProviders.restart.impact'),
      okText: t('identityProviders.restart.confirm'),
      title: t('identityProviders.restart.title'),
      onOk: async () => {
        try {
          await requestAdminReauth({ authMethod });
          openReasonModal({
            authMethod,
            buildPayload: (reason) => ({ reason, requestId: crypto.randomUUID() }),
            danger: true,
            impact: t('identityProviders.restart.impact'),
            onSubmit: async (payload) => {
              const input = payload as { reason: string; requestId: string };
              try {
                const prepared = await adminIdentityProvidersService.prepareRestart(input);
                const result = await adminIdentityProvidersService.requestRestart({
                  ...input,
                  intentToken: prepared.intentToken,
                });
                if (restartLifecycle.accept(prepared, result)) {
                  try {
                    await runtime.mutate();
                    toast.success(t('identityProviders.restart.accepted'));
                  } catch {
                    toast.warning(
                      t('identityProviders.restart.acceptedRefreshFailed', {
                        defaultValue:
                          'Restart accepted, but runtime status could not be refreshed. Retry status — do not restart again.',
                      }),
                    );
                  }
                } else {
                  throw new Error('restart acceptance mismatch');
                }
              } catch (cause) {
                restartLifecycle.fail();
                throw cause;
              }
            },
            submitLabel: t('identityProviders.restart.confirm'),
            targetLabel: t('identityProviders.restart.target'),
            title: t('identityProviders.restart.reasonTitle'),
          });
        } catch (cause) {
          if (cause instanceof AdminReauthCancelledError) return;
          toast.error(t('identityProviders.restart.reauthFailed'));
        }
      },
    });
  };

  return { requestRestart };
};
