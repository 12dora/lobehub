'use client';

import { Alert, Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { isProviderWebSessionOnly } from 'model-bank/modelProviders';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { notifyAdminAiInfraError } from '@/enterprise/client/services/adminAiInfraAdapter/errors';
import { usePlatformAiTakeover } from '@/features/ManagedResources';
import { useProviderName } from '@/hooks/useProviderName';
import { useClientDataSWR } from '@/libs/swr';
import { lambdaClient } from '@/libs/trpc/client';
import { useAiInfraStoreApi, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import SharedOAuthBadge from './SharedOAuthBadge';
import SharedOAuthConnectedCard from './SharedOAuthConnectedCard';
import SharedOAuthFlowStates from './SharedOAuthFlowStates';
import { buildAdminSharedOAuthStatusKey, formatExpiry } from './sharedOAuthFormat';
import SharedOAuthPasteForm from './SharedOAuthPasteForm';
import { useAdminSharedOAuthFlow } from './useAdminSharedOAuthFlow';

export {
  ADMIN_SHARED_OAUTH_STATUS_KEY,
  buildAdminSharedOAuthStatusKey,
  formatExpiry,
} from './sharedOAuthFormat';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    width: 100%;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
}));

/** Audit reason recorded for the reauth-gated withdrawal of the shared account. */
const DISCONNECT_REASON = 'admin shared provider account disconnect';

/**
 * Managed-resources tab of the unified admin page: the ONLY place where the shared
 * catalog is handed to members ("Platform managed").
 */
const MANAGED_RESOURCES_PATH = '/admin/unified?tab=managed';

interface SharedOAuthConnectProps {
  providerId: string;
}

/**
 * Platform-owned device-flow connect panel for rotating-refresh providers
 * (chatgpt / chatgptweb / supergrok): ONE account is stored in the platform vault and serves
 * every member. Never rendered on the user surface.
 */
const SharedOAuthConnect = memo<SharedOAuthConnectProps>(({ providerId }) => {
  const { t } = useTranslation('admin');
  const storeApi = useAiInfraStoreApi();
  const name = useProviderName(providerId);
  /**
   * Read from the provider card, never from an id list: this panel serves every
   * rotating-refresh provider, and only the card knows which connect routes it has.
   */
  const webSessionOnly = isProviderWebSessionOnly(providerId);
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

  const {
    connect,
    deviceCode,
    error,
    reset,
    state,
    submitAccessToken,
    submitCallback,
    submitError,
    submitErrorSource,
    submitSessionToken,
    submitting,
  } = useAdminSharedOAuthFlow({
    onStatusStale: handleStatusStale,
    onSuccess: handleStored,
    providerId,
  });

  /**
   * Whether the flow was started from the "cannot renew itself" warning's primary fix, in
   * which case the paste panel must open ON the web-session box instead of making the
   * operator hunt for the section they just asked for.
   */
  const [openSessionSection, setOpenSessionSection] = useState(false);

  const handleConnect = useCallback(async () => {
    // A web-session-only provider has exactly one box to land on, and this is it.
    setOpenSessionSection(webSessionOnly);
    const info = await connect();
    // The paste flow opens the authorization page from its own explicit step: the operator
    // has to come back with the callback URL, so the instructions must be read first.
    if (info?.flow === 'authorization_code_paste') return;
    // The click still counts as user activation here, so the popup normally opens;
    // the explicit button below stays as the fallback when it is blocked.
    const uri = info?.verificationUriComplete || info?.verificationUri;
    if (uri) window.open(uri, '_blank', 'noopener,noreferrer');
  }, [connect, webSessionOnly]);

  /** Same flow, landing on the web-session box — the one-paste route to auto-renewal. */
  const handleConnectWithSession = useCallback(async () => {
    setOpenSessionSection(true);
    await connect();
  }, [connect]);

  /**
   * Withdraw the shared account. Confirmation is mandatory: unlike the user-side disconnect
   * (one person, self-serve reconnect) this removes the credential EVERY member is using and
   * turns the provider off, and members have no way to restore it themselves.
   */
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
   * The shared credential was TERMINALLY rejected and only an operator can fix it. Two
   * observations feed one state, because they mean the same thing to the person reading this
   * card: `expired` is this request's own refresh coming back `invalid_grant`, `needsReauth`
   * is the marker an earlier observation wrote into the vault — including a member's chat
   * being answered with 401, which is the case the card used to miss entirely (an unexpired
   * token string sitting in the vault made the refresh a no-op and the badge said 已连接).
   */
  const needsReauth = Boolean(status && (status.needsReauth || status.expired));
  const invalidAt = formatExpiry(status?.invalidAt ?? null);
  const reauthReason = status?.invalidReason
    ? t(`aiProviderSettings.sharedOAuth.reauth.reason.${status.invalidReason}` as any)
    : undefined;
  /** Reason + when, for the badge tooltip — the badge itself stays one short word. */
  const reauthDetail =
    [
      reauthReason,
      invalidAt ? t('aiProviderSettings.sharedOAuth.reauth.observedAt', { time: invalidAt }) : '',
    ]
      .filter(Boolean)
      .join(' · ') || t('aiProviderSettings.sharedOAuth.reauth.message', { name });

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
    if (state === 'awaiting' && deviceCode?.flow === 'authorization_code_paste') {
      return (
        <SharedOAuthPasteForm
          allowAccessTokenPaste={deviceCode.allowAccessTokenPaste}
          authorizeUri={deviceCode.verificationUriComplete || deviceCode.verificationUri}
          defaultSessionOpen={openSessionSection}
          submitError={submitError}
          submitErrorSource={submitErrorSource}
          submitting={submitting}
          webSessionOnly={webSessionOnly}
          onCancel={reset}
          onOpenAuthorizePage={handleOpenVerification}
          onRegenerate={handleConnect}
          onSubmitAccessToken={submitAccessToken}
          onSubmitCallback={submitCallback}
          onSubmitSessionToken={submitSessionToken}
        />
      );
    }

    if (state === 'requesting' || state === 'error' || (state === 'awaiting' && deviceCode)) {
      return (
        <SharedOAuthFlowStates
          deviceCode={deviceCode}
          error={error}
          name={name}
          state={state}
          onConnect={handleConnect}
          onOpenVerification={handleOpenVerification}
          onReset={reset}
        />
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

    return (
      <SharedOAuthConnectedCard
        disconnecting={disconnecting}
        enforcementHint={renderEnforcementHint()}
        name={name}
        needsReauth={needsReauth}
        reauthDetail={reauthDetail}
        status={status}
        webSessionOnly={webSessionOnly}
        onConnect={handleConnect}
        onConnectWithSession={handleConnectWithSession}
        onDisconnect={handleDisconnect}
      />
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
        <SharedOAuthBadge
          connected={Boolean(status?.connected)}
          needsReauth={needsReauth}
          reauthDetail={reauthDetail}
          visible={!isLoading && !statusError && Boolean(status)}
        />
      </Flexbox>
      {renderBody()}
    </Flexbox>
  );
});

SharedOAuthConnect.displayName = 'AdminSharedOAuthConnect';

export default SharedOAuthConnect;
