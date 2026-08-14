'use client';

import { Alert, CopyButton, Flexbox, Icon, Skeleton, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, UnplugIcon } from 'lucide-react';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';
import { useAiInfraStoreApi, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import { useAdminSharedOAuthFlow } from './useAdminSharedOAuthFlow';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    width: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
  `,
  code: css`
    padding-block: 12px;
    padding-inline: 20px;
    border-radius: 8px;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 4px;

    background: ${cssVar.colorFillTertiary};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

export const ADMIN_SHARED_OAUTH_STATUS_KEY = 'admin.aiProviderOAuth.getConnectionStatus' as const;

export const buildAdminSharedOAuthStatusKey = (providerId: string) =>
  [ADMIN_SHARED_OAUTH_STATUS_KEY, providerId] as const;

const providerDisplayName = (providerId: string) =>
  DEFAULT_MODEL_PROVIDER_LIST.find((provider) => provider.id === providerId)?.name ?? providerId;

/** Vault stores epoch millis as a string; anything unparsable is treated as unknown. */
const formatExpiry = (expiresAt: string | null): string | undefined => {
  if (!expiresAt) return undefined;
  const millis = Number(expiresAt);
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return new Date(millis).toLocaleString();
};

interface SharedOAuthConnectProps {
  providerId: string;
}

/**
 * Platform-owned device-flow connect panel for rotating-refresh providers
 * (chatgpt / supergrok): ONE account is stored in the platform vault and serves
 * every member. Never rendered on the user surface.
 */
const SharedOAuthConnect = memo<SharedOAuthConnectProps>(({ providerId }) => {
  const { t } = useTranslation('admin');
  const storeApi = useAiInfraStoreApi();
  const name = providerDisplayName(providerId);
  /**
   * Follow-up hint source: PERSISTED platform model rows only.
   *
   * `aiProviderModelList` is the merged view — it carries the enabled model-bank defaults even
   * when this provider has zero rows in the platform catalog, so a first ChatGPT/SuperGrok
   * connect would claim "live" while the runtime (which reads published rows) sees a model-less
   * provider and drops it. `enabledAiModels` comes from the admin runtime state, which is built
   * from the persisted draft models of enabled providers, so it cannot lie in that direction.
   */
  const hasPersistedEnabledModel = useAiInfraStore((s) =>
    (s.enabledAiModels ?? []).some((model) => model.providerId === providerId),
  );

  const statusKey = buildAdminSharedOAuthStatusKey(providerId);
  const {
    data: status,
    error: statusError,
    isLoading,
    mutate: refreshStatus,
  } = useClientDataSWR(
    statusKey,
    () => lambdaClient.admin.aiProviderOAuth.getConnectionStatus.query({ id: providerId }),
    { revalidateOnFocus: false },
  );

  const handleStored = useCallback(async () => {
    // The connection is already committed server-side; a failing refresh must not be
    // reported as a failed connect — the panel keeps its success state either way.
    // Uses the bound mutate: useClientDataSWR augments the key with the workspace id.
    try {
      await refreshStatus();
      await storeApi.getState().refreshAiProviderDetail();
      await storeApi.getState().refreshAiProviderList();
      // The create path activates the provider server-side, so the runtime projection (which
      // drives the "live" hint and the model list) is stale until it is re-read.
      await storeApi.getState().refreshAiProviderRuntimeState();
    } catch {
      /* stale view only; the next revalidation recovers it */
    }
  }, [refreshStatus, storeApi]);

  const handleStatusStale = useCallback(() => {
    // A cancelled/expired/failed flow can still sit on a connection the server stored:
    // re-read the status instead of leaving the idle card on the pre-connect answer.
    // Wrapped because a failing revalidation is a stale view only, never a user error.
    void Promise.resolve(refreshStatus()).catch(() => {});
  }, [refreshStatus]);

  const { connect, deviceCode, error, reset, state } = useAdminSharedOAuthFlow({
    onStatusStale: handleStatusStale,
    onSuccess: handleStored,
    providerId,
  });

  const handleConnect = useCallback(async () => {
    const info = await connect();
    // The click still counts as user activation here, so the popup normally opens;
    // the explicit button below stays as the fallback when it is blocked.
    const uri = info?.verificationUriComplete || info?.verificationUri;
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  }, [connect]);

  const handleOpenVerification = useCallback(() => {
    const uri = deviceCode?.verificationUriComplete || deviceCode?.verificationUri;
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  }, [deviceCode?.verificationUri, deviceCode?.verificationUriComplete]);

  /**
   * A `success` poll means the account was applied unconditionally — it is already live for
   * every member. Anything that failed on the way surfaces as an error state instead, so the
   * only variation left here is the follow-up hint for a provider that still has no model on.
   */
  const renderStoredAlert = () => (
    <Alert
      type={'success'}
      message={t(
        hasPersistedEnabledModel
          ? 'aiProviderSettings.sharedOAuth.success.published'
          : 'aiProviderSettings.sharedOAuth.success.needsModels',
      )}
    />
  );

  const renderBody = () => {
    if (state === 'requesting') {
      // Always offer a way out: the provider can stall for minutes on this call, and the
      // flow's staleness guards make a cancelled request safe to discard when it lands.
      return (
        <Flexbox gap={12}>
          <Flexbox horizontal align={'center'} gap={8}>
            <Icon spin icon={Loader2Icon} />
            <Text type={'secondary'}>{t('aiProviderSettings.sharedOAuth.requesting')}</Text>
          </Flexbox>
          <Flexbox horizontal>
            <Button onClick={reset}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
          </Flexbox>
        </Flexbox>
      );
    }

    if (state === 'error') {
      return (
        <Flexbox gap={12}>
          <Flexbox horizontal align={'center'} gap={8}>
            <Icon color={cssVar.colorError} icon={UnplugIcon} />
            <Text type={'danger'}>
              {t(`aiProviderSettings.sharedOAuth.error.${error ?? 'authError'}` as any)}
            </Text>
          </Flexbox>
          <Flexbox horizontal gap={8}>
            <Button type={'primary'} onClick={handleConnect}>
              {t('aiProviderSettings.sharedOAuth.retry')}
            </Button>
            <Button onClick={reset}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
          </Flexbox>
        </Flexbox>
      );
    }

    if (state === 'awaiting' && deviceCode) {
      return (
        <Flexbox gap={12}>
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.enterCode', { name })}
          </Text>
          <Flexbox horizontal align={'center'} gap={12}>
            <div className={styles.code}>{deviceCode.userCode}</div>
            <CopyButton content={deviceCode.userCode} />
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={8}>
            <Button
              icon={<Icon icon={ExternalLinkIcon} />}
              type={'primary'}
              onClick={handleOpenVerification}
            >
              {t('aiProviderSettings.sharedOAuth.openPage')}
            </Button>
            <Button onClick={reset}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={8}>
            <Icon spin icon={Loader2Icon} />
            <Text className={styles.hint}>{t('aiProviderSettings.sharedOAuth.polling')}</Text>
          </Flexbox>
          <Text className={styles.hint}>{deviceCode.verificationUri}</Text>
        </Flexbox>
      );
    }

    if (state === 'success') {
      return (
        <Flexbox gap={12}>
          {renderStoredAlert()}
          <Flexbox horizontal>
            <Button onClick={reset}>{t('aiProviderSettings.sharedOAuth.done')}</Button>
          </Flexbox>
        </Flexbox>
      );
    }

    if (isLoading) return <Skeleton active paragraph={{ rows: 1 }} title={false} />;

    if (statusError) {
      return (
        <Flexbox gap={12}>
          <Alert message={t('aiProviderSettings.sharedOAuth.statusFailed')} type={'warning'} />
          <Flexbox horizontal>
            <Button onClick={() => void refreshStatus()}>
              {t('aiProviderSettings.sharedOAuth.retryStatus')}
            </Button>
          </Flexbox>
        </Flexbox>
      );
    }

    const expiry = formatExpiry(status?.expiresAt ?? null);

    return (
      <Flexbox gap={12}>
        {status?.connected ? (
          <Flexbox gap={4}>
            <Text className={styles.meta}>
              {status.accountIdMasked
                ? t('aiProviderSettings.sharedOAuth.account', { account: status.accountIdMasked })
                : t('aiProviderSettings.sharedOAuth.accountUnknown')}
            </Text>
            <Text className={styles.hint}>
              {expiry
                ? t('aiProviderSettings.sharedOAuth.expiresAt', { time: expiry })
                : t('aiProviderSettings.sharedOAuth.autoRefresh')}
            </Text>
          </Flexbox>
        ) : (
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.disconnectedHint', { name })}
          </Text>
        )}
        <Flexbox horizontal>
          <Button type={status?.connected ? 'default' : 'primary'} onClick={handleConnect}>
            {t(
              status?.connected
                ? 'aiProviderSettings.sharedOAuth.reconnect'
                : 'aiProviderSettings.sharedOAuth.connect',
            )}
          </Button>
        </Flexbox>
      </Flexbox>
    );
  };

  // Never claim a state we have not read yet: no badge until the status resolves.
  const renderBadge = () => {
    if (isLoading || statusError || !status) return null;
    if (!status.connected) return <Tag>{t('aiProviderSettings.sharedOAuth.notConnected')}</Tag>;
    return (
      <Tag color={'success'}>
        <Flexbox horizontal align={'center'} gap={4}>
          <Icon icon={CheckCircle2Icon} size={12} />
          {t('aiProviderSettings.sharedOAuth.connected')}
        </Flexbox>
      </Tag>
    );
  };

  return (
    <Flexbox className={styles.card} gap={16} padding={16}>
      <Flexbox horizontal align={'flex-start'} gap={12} justify={'space-between'}>
        <Flexbox gap={2}>
          <Text weight={600}>{t('aiProviderSettings.sharedOAuth.title')}</Text>
          <Text className={styles.hint}>
            {t('aiProviderSettings.sharedOAuth.description', { name })}
          </Text>
        </Flexbox>
        {renderBadge()}
      </Flexbox>
      {renderBody()}
    </Flexbox>
  );
});

SharedOAuthConnect.displayName = 'AdminSharedOAuthConnect';

export default SharedOAuthConnect;
