'use client';

import { Alert, CopyButton, Flexbox, Icon, Skeleton, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon, UnplugIcon } from 'lucide-react';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { notifyAdminAiInfraError } from '@/enterprise/client/services/adminAiInfraAdapter/errors';
import { usePlatformAiTakeover } from '@/features/ManagedResources';
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

/** Audit reason recorded for the reauth-gated withdrawal of the shared account. */
const DISCONNECT_REASON = 'admin shared provider account disconnect';

/**
 * Managed-resources tab of the unified admin page: the ONLY place where the shared
 * catalog is handed to members ("Platform managed").
 */
const MANAGED_RESOURCES_PATH = '/admin/unified?tab=managed';

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
  const [disconnecting, setDisconnecting] = useState(false);
  /**
   * Whether the platform AI catalog actually OVERRIDES what members use right now
   * (published `managed + enforced` + the feature flag) — not merely whether their settings
   * UI is blocked. `useManagedResource('aiProviders').managed` is the wrong signal here: it
   * is also true for `ui-only`, where members keep using their own accounts and this shared
   * one reaches nobody. Read from the app-wide capability context: no extra request, and no
   * POLICY_READ requirement on an operator who only administers AI.
   *
   * While it is loading or failed we say nothing: a hint that guesses wrong is worse than
   * no hint.
   */
  const { loading: platformLoading, error: platformError, takeover } = usePlatformAiTakeover();
  const takeoverKnown = !platformLoading && platformError === null;
  const showEnforcementHint = takeoverKnown && !takeover;
  /**
   * Same source as the header EnableSwitch (`aiProviderSelectors.isProviderEnabled`), so the
   * success copy cannot claim a provider is serving members while that switch reads off.
   * Storing a credential never enables anything on the update path — only first connect does.
   */
  const providerEnabled = useAiInfraStore((s) =>
    (s.aiProviderList ?? []).some((item) => item.id === providerId && item.enabled === true),
  );
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
    // The write is already committed server-side; a failing refresh must not be reported as
    // a failed write — the panel keeps its outcome state either way.
    try {
      const state = storeApi.getState();
      /**
       * allSettled, NOT a sequential await chain: these four reads are independent, and one
       * rejection used to skip every later refresh. The runtime-state read is the one that
       * must not be skipped — it drives the header EnableSwitch and the provider grid, both
       * of which would keep showing a provider this write just turned off.
       *
       * refreshStatus uses the bound mutate: useClientDataSWR augments the key with the
       * workspace id.
       */
      await Promise.allSettled([
        refreshStatus(),
        state.refreshAiProviderDetail(),
        state.refreshAiProviderList(),
        state.refreshAiProviderRuntimeState(),
      ]);
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

  /**
   * Withdraw the shared account. Confirmation is mandatory: unlike the user-side disconnect
   * (one person, self-serve reconnect) this removes the credential EVERY member is using and
   * turns the provider off, and members have no way to restore it themselves.
   */
  const handleDisconnect = useCallback(() => {
    confirmModal({
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
          // The write is already committed site-wide; handleStored never rejects, so a
          // failing revalidation cannot be reported as a failed disconnect.
          await handleStored();
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
  }, [handleStored, name, providerId, t]);

  const handleOpenVerification = useCallback(() => {
    const uri = deviceCode?.verificationUriComplete || deviceCode?.verificationUri;
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  }, [deviceCode?.verificationUri, deviceCode?.verificationUriComplete]);

  /**
   * A connected account is not the same as an account members use. This says so, and points
   * at the one page that changes it. Rendered in BOTH the just-connected view and the idle
   * connected view — the moment right after connecting is exactly when an operator concludes
   * "done", so leaving it out there was the whole gap.
   */
  const renderEnforcementHint = () =>
    showEnforcementHint ? (
      <Text className={styles.hint}>
        {t('aiProviderSettings.sharedOAuth.enforcementHint')}{' '}
        <Link to={MANAGED_RESOURCES_PATH}>
          {t('aiProviderSettings.sharedOAuth.enforcementHintLink')}
        </Link>
      </Text>
    ) : null;

  /**
   * A `success` poll means the account was applied unconditionally — the CREDENTIAL is
   * stored and published. That alone promises nothing to members, so every claim below is
   * read from real state instead, in the order an operator would have to fix them:
   *   - provider off (only first connect enables the row; a reconnect after a disconnect
   *     deliberately leaves it off) ⇒ turn it on;
   *   - no persisted enabled model ⇒ turn one on;
   *   - no platform AI takeover ⇒ members are still on their own accounts;
   *   - otherwise, and only then, the provider really is on for members.
   */
  const renderStoredAlert = () => {
    const messageKey = !providerEnabled
      ? 'aiProviderSettings.sharedOAuth.success.providerOff'
      : !hasPersistedEnabledModel
        ? 'aiProviderSettings.sharedOAuth.success.needsModels'
        : // Fails closed, unlike the additive hint: "on for members" needs a POSITIVE
          // takeover reading, never merely the absence of one.
          takeover
          ? 'aiProviderSettings.sharedOAuth.success.published'
          : 'aiProviderSettings.sharedOAuth.success.pendingTakeover';
    return <Alert message={t(messageKey)} type={'success'} />;
  };

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
          {renderEnforcementHint()}
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
    /**
     * Prefer the full sign-in email: it is the only human-readable identity of the shared
     * account, and an operator needs to recognise WHICH account is connected. `accountIdMasked`
     * is a 4-char prefix of the Codex workspace UUID — it identifies nothing to a human, so it
     * is only the fallback for connections stored before the email was captured.
     */
    const account = status?.accountEmail ?? status?.accountIdMasked ?? null;

    return (
      <Flexbox gap={12}>
        {status?.connected ? (
          <Flexbox gap={4}>
            <Text className={styles.meta}>
              {account
                ? t('aiProviderSettings.sharedOAuth.account', { account })
                : t('aiProviderSettings.sharedOAuth.accountUnknown')}
            </Text>
            <Text className={styles.hint}>
              {expiry
                ? t('aiProviderSettings.sharedOAuth.expiresAt', { time: expiry })
                : t('aiProviderSettings.sharedOAuth.autoRefresh')}
            </Text>
            {renderEnforcementHint()}
          </Flexbox>
        ) : (
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.disconnectedHint', { name })}
          </Text>
        )}
        <Flexbox horizontal gap={8}>
          <Button type={status?.connected ? 'default' : 'primary'} onClick={handleConnect}>
            {t(
              status?.connected
                ? 'aiProviderSettings.sharedOAuth.reconnect'
                : 'aiProviderSettings.sharedOAuth.connect',
            )}
          </Button>
          {status?.connected && (
            <Button danger loading={disconnecting} onClick={handleDisconnect}>
              {t('aiProviderSettings.sharedOAuth.disconnect')}
            </Button>
          )}
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
