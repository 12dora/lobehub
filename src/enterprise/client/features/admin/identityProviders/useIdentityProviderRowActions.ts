'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { confirmModal, toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import { useCallback } from 'react';

import { AdminReauthCancelledError } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminAccessContextValue } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';
import { lambdaClient } from '@/libs/trpc/client';

import { openReasonModal } from '../users/modals/openReasonModal';

interface UseIdentityProviderRowActionsInput {
  authMethod: AdminAccessContextValue['authMethod'];
  canDelete: boolean;
  canDisable: boolean;
  isDeletable: (provider: PlatformIdentityProviderDraft) => boolean;
  isDisableable: (provider: PlatformIdentityProviderDraft) => boolean;
  refreshProviders: () => unknown;
  runtime: { mutate: () => Promise<unknown> };
  t: TFunction<'admin'>;
}

export const useIdentityProviderRowActions = ({
  authMethod,
  canDelete,
  canDisable,
  isDeletable,
  isDisableable,
  refreshProviders,
  runtime,
  t,
}: UseIdentityProviderRowActionsInput) => {
  const requestDisable = useCallback(
    (provider: PlatformIdentityProviderDraft) => {
      if (!canDisable) return;
      if (!isDisableable(provider)) return;
      confirmModal({
        cancelText: t('identityProviders.disable.cancel', {
          defaultValue: 'Cancel',
        }),
        content: t('identityProviders.disable.impact', {
          defaultValue:
            'Disabling this sign-in method stops new logins after all running instances reload. To restore it later, publish a new configuration.',
        }),
        okButtonProps: { danger: true },
        okText: t('identityProviders.disable.confirm', { defaultValue: 'Disable provider' }),
        title: t('identityProviders.disable.title', { defaultValue: 'Disable identity provider' }),
        onOk: async () => {
          try {
            // No eager reauth popup here: the reason modal below runs through
            // `withAdminReauthRetry`, which challenges only if the server actually
            // asks. Calling it up front made one action cost two popups.
            openReasonModal({
              authMethod,
              buildPayload: (reason) => ({ reason }),
              danger: true,
              impact: t('identityProviders.disable.impact', {
                defaultValue:
                  'Disabling this sign-in method stops new logins after all running instances reload. To restore it later, publish a new configuration.',
              }),
              onSubmit: async (payload) => {
                const { reason } = payload as { reason: string };
                await adminIdentityProvidersService.disable({
                  expectedRevision: provider.revision,
                  id: provider.id,
                  reason,
                });
                await refreshProviders();
                // Commit and runtime refresh are separate outcomes (XT-005).
                try {
                  await runtime.mutate();
                  toast.success(
                    t('identityProviders.disable.success', {
                      defaultValue: 'Provider disabled — restart required',
                    }),
                  );
                } catch {
                  toast.warning(
                    t('identityProviders.disable.committedRefreshFailed', {
                      defaultValue:
                        'Provider disabled, but runtime status could not be refreshed. Retry status — do not disable again.',
                    }),
                  );
                }
              },
              submitLabel: t('identityProviders.disable.confirm', {
                defaultValue: 'Disable provider',
              }),
              targetLabel: provider.displayName,
              title: t('identityProviders.disable.title', {
                defaultValue: 'Disable identity provider',
              }),
            });
          } catch (cause) {
            if (cause instanceof AdminReauthCancelledError) return;
            toast.error(t('identityProviders.errors.generic', { defaultValue: 'Request failed' }));
          }
        },
      });
    },
    [authMethod, canDisable, isDisableable, refreshProviders, runtime, t],
  );

  const requestDelete = useCallback(
    (provider: PlatformIdentityProviderDraft) => {
      if (!canDelete) return;
      if (!isDeletable(provider)) return;
      confirmModal({
        cancelText: t('identityProviders.delete.cancel'),
        content: t('identityProviders.delete.impact'),
        okButtonProps: { danger: true },
        okText: t('identityProviders.delete.confirm'),
        title: t('identityProviders.delete.title'),
        onOk: async () => {
          try {
            // No eager reauth popup here: the reason modal below runs through
            // `withAdminReauthRetry`, which challenges only if the server actually
            // asks. Calling it up front made one action cost two popups.
            openReasonModal({
              authMethod,
              buildPayload: (reason) => ({ reason }),
              danger: true,
              impact: t('identityProviders.delete.impact'),
              onSubmit: async (payload) => {
                const { reason } = payload as { reason: string };
                await lambdaClient.admin.identityProviders.delete.mutate({
                  expectedRevision: provider.revision,
                  id: provider.id,
                  reason,
                });
                await refreshProviders();
                toast.success(t('identityProviders.delete.success'));
              },
              submitLabel: t('identityProviders.delete.confirm'),
              targetLabel: provider.displayName,
              title: t('identityProviders.delete.title'),
            });
          } catch (cause) {
            if (cause instanceof AdminReauthCancelledError) return;
            toast.error(t('identityProviders.errors.generic'));
          }
        },
      });
    },
    [authMethod, canDelete, isDeletable, refreshProviders, t],
  );

  return { requestDelete, requestDisable };
};
