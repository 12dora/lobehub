import { App } from 'antd';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

// From the hook module, not the barrel: the barrel also exports the boundary components, so a
// barrel import drags a whole component tree behind a two-field capability read.
import { usePlatformAiTakeover } from '@/features/ManagedResources/useManagedResource';
import { usePermission } from '@/hooks/usePermission';
import { useScopedAiInfraStore } from '@/store/aiInfra';

/**
 * A runtime with no enumerator fails in a way no operator action can fix — there is no account
 * to reconnect and no binary to install — so it gets its own copy instead of the cause line.
 *
 * The server marks this case on the error body rather than by status, because it is otherwise
 * indistinguishable from an upstream that legitimately returned an empty list.
 */
const cannotEnumerate = (error: unknown): boolean =>
  (error as { data?: { errorData?: { details?: { reason?: string } } } } | null)?.data?.errorData
    ?.details?.reason === 'cannot_enumerate';

/**
 * Drives the "sync upstream models" menu item for both provider settings panels.
 *
 * The two panels administer different credentials, so the store dispatches on its injected
 * services; what this hook decides is whether the action may be offered at all.
 */
export const useSyncUpstreamModels = (provider: string) => {
  const { t } = useTranslation('modelProvider');
  const { message } = App.useApp();
  const { allowed: canManageProvider, reason } = usePermission('manage_provider_key');
  const { takeover, takeoverKnown } = usePlatformAiTakeover();
  const [supportsUpstreamSync, syncUpstreamModelList] = useScopedAiInfraStore((s) => [
    s.supportsUpstreamSync,
    s.syncUpstreamModelList,
  ]);
  const [isSyncing, setIsSyncing] = useState(false);

  // A member's model list is an overlay on the catalog the administrator publishes; writing a
  // live upstream list into it would fork the two. Only panels that administer the platform
  // credential itself are exempt. An unknown takeover state counts as managed for the same
  // reason `useManagedResource` treats it as blocked — a wrong "not managed" is the harmful
  // direction, and this action is recoverable by simply retrying once the capability resolves.
  const managedByAdmin = !supportsUpstreamSync && (takeover || !takeoverKnown);

  const disabledReason = managedByAdmin
    ? t('providerModels.list.syncUpstream.managed')
    : canManageProvider
      ? undefined
      : reason;

  const disabled = managedByAdmin || !canManageProvider;

  const syncUpstream = useCallback(async () => {
    if (disabled || isSyncing) return;

    setIsSyncing(true);
    try {
      const { created, total } = await syncUpstreamModelList(provider);

      if (total === 0) {
        message.info(t('providerModels.list.syncUpstream.empty'));
        return;
      }

      message.success(t('providerModels.list.syncUpstream.success', { created, total }));
    } catch (error) {
      console.error(error);

      if (cannotEnumerate(error)) {
        message.error(t('providerModels.list.syncUpstream.unsupported'));
        return;
      }

      message.error(
        t('providerModels.list.syncUpstream.error', {
          message:
            error instanceof Error ? error.message : t('providerModels.list.fetcher.errorFallback'),
        }),
      );
    } finally {
      // A rejected sync must not leave the trigger spinning forever.
      setIsSyncing(false);
    }
  }, [disabled, isSyncing, message, provider, syncUpstreamModelList, t]);

  return { disabled, disabledReason, isSyncing, syncUpstream };
};
