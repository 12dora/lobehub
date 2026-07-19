'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { requestAdminReauth } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { openReasonModal } from '../users/modals/openReasonModal';
import IdentityProviderWizard from './IdentityProviderWizard';
import {
  useAuthSnapshotStatus,
  useIdentityProviderCallbacks,
  useIdentityProviders,
} from './useIdentityProviders';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  columns: css`
    display: grid;
    grid-template-columns: minmax(220px, 0.28fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;

    @media (width <= 840px) {
      grid-template-columns: 1fr;
    }
  `,
  instance: css`
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;

    padding-block: 6px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
}));

const IdentityProviderPage = memo(() => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions, status: accessStatus } = useAdminAccess();
  const canRead = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_READ);
  const canCreate = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_CREATE);
  const canUpdate = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_UPDATE);
  const canTest = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_TEST);
  const canPublish = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH);
  const canRestart = permissions.includes(PLATFORM_PERMISSIONS.OIDC_PUBLISH);
  const enabled = accessStatus === 'allowed' && canRead;
  const providers = useIdentityProviders(enabled);
  const callbacks = useIdentityProviderCallbacks(enabled);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [restartAccepted, setRestartAccepted] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // This privileged query is never mounted for read-only identity administrators.
  const runtime = useAuthSnapshotStatus(accessStatus === 'allowed' && canRestart, restartAccepted);
  const selected = useMemo(
    () => providers.data?.items.find((item) => item.id === selectedId) ?? providers.data?.items[0],
    [providers.data?.items, selectedId],
  );

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
              setRestartError(null);
              try {
                const prepared = await adminIdentityProvidersService.prepareRestart(input);
                const result = await adminIdentityProvidersService.requestRestart({
                  ...input,
                  intentToken: prepared.intentToken,
                });
                if (result.accepted) {
                  // The controller signals only after this committed response and a grace delay.
                  // A failed follow-up status fetch is a reconnect state, not a rejected restart.
                  setRestartAccepted(true);
                  await runtime.mutate().catch(() => undefined);
                  toast.success(t('identityProviders.restart.accepted'));
                }
              } catch (cause) {
                setRestartAccepted(false);
                const message = cause instanceof Error ? cause.message : String(cause);
                setRestartError(message);
                throw cause;
              }
            },
            submitLabel: t('identityProviders.restart.confirm'),
            targetLabel: t('identityProviders.restart.target'),
            title: t('identityProviders.restart.reasonTitle'),
          });
        } catch {
          toast.error(t('identityProviders.restart.reauthFailed'));
        }
      },
    });
  };

  if (!canRead) {
    return <Alert showIcon description={t('identityProviders.errors.forbidden')} type="warning" />;
  }

  return (
    <AdminPageTemplate
      description={t('identityProviders.description')}
      title={t('identityProviders.title')}
      actions={
        <Flexbox horizontal gap={8}>
          {canCreate ? (
            <Button onClick={() => setCreating(true)}>
              {t('identityProviders.actions.create')}
            </Button>
          ) : null}
          {canRestart && runtime.data?.pendingRestart && runtime.data.restart.supported ? (
            <Button danger onClick={requestRestart}>
              {t('identityProviders.actions.restart')}
            </Button>
          ) : null}
        </Flexbox>
      }
      banner={
        restartAccepted && runtime.error ? (
          <Alert showIcon description={t('identityProviders.restart.reconnecting')} type="info" />
        ) : runtime.error && canRestart ? (
          <Alert
            showIcon
            description={t('identityProviders.runtime.loadError')}
            type="error"
            action={
              <Button size="small" onClick={() => void runtime.mutate()}>
                {t('identityProviders.actions.retry')}
              </Button>
            }
          />
        ) : null
      }
    >
      {runtime.data && canRestart ? (
        <Flexbox gap={10}>
          {restartError ? <Alert showIcon description={restartError} type="error" /> : null}
          <div className={styles.card} data-testid="identity-runtime-status">
            <Flexbox horizontal gap={8} justify="space-between">
              <Text strong>{t('identityProviders.runtime.title')}</Text>
              <Tag color={runtime.data.artifact.health === 'healthy' ? 'green' : 'orange'}>
                {runtime.data.artifact.health}
              </Tag>
            </Flexbox>
            <Text type="secondary">
              {t('identityProviders.runtime.source', { source: runtime.data.artifact.source })} ·{' '}
              {runtime.data.artifact.identityRevision?.slice(0, 12) ?? '—'}
            </Text>
            <Text>
              {t('identityProviders.runtime.pending', {
                count: runtime.data.pendingPublished.length,
              })}
            </Text>
            {runtime.data.pendingPublished
              .filter((provider) => provider.blockedCategory)
              .map((provider) => (
                <Alert
                  showIcon
                  key={provider.providerId}
                  type="warning"
                  description={t('identityProviders.runtime.environmentShadowed', {
                    category: provider.blockedCategory,
                    provider: provider.providerKey,
                  })}
                />
              ))}
            {runtime.data.active.partial ? (
              <Alert showIcon description={t('identityProviders.runtime.partial')} type="warning" />
            ) : null}
            {runtime.data.artifact.health === 'degraded' ? (
              <Alert
                showIcon
                type="warning"
                description={t('identityProviders.runtime.degraded', {
                  category: runtime.data.artifact.degradedCategory ?? 'unknown',
                })}
              />
            ) : null}
            {!runtime.data.restart.supported && runtime.data.pendingRestart ? (
              <Alert
                showIcon
                type="info"
                description={t('identityProviders.restart.unsupported', {
                  reason: runtime.data.restart.reason,
                })}
              />
            ) : null}
            {runtime.data.instances.map((instance) => (
              <div className={styles.instance} key={instance.instanceId}>
                <Text>{instance.instanceId.slice(0, 16)}…</Text>
                <Tag color={instance.fresh ? 'green' : 'default'}>
                  {instance.fresh
                    ? t('identityProviders.runtime.fresh')
                    : t('identityProviders.runtime.stale')}
                </Tag>
              </div>
            ))}
          </div>
        </Flexbox>
      ) : null}

      {providers.isLoading ? (
        <Text role="status">{t('identityProviders.loading')}</Text>
      ) : providers.error ? (
        <Alert
          showIcon
          description={t('identityProviders.errors.load')}
          type="error"
          action={
            <Button size="small" onClick={() => void providers.mutate()}>
              {t('identityProviders.actions.retry')}
            </Button>
          }
        />
      ) : (
        <div className={styles.columns}>
          <div className={styles.list}>
            {(providers.data?.items.length ?? 0) === 0 ? (
              <Alert showIcon description={t('identityProviders.empty')} type="info" />
            ) : (
              providers.data?.items.map((provider) => (
                <button
                  className={styles.card}
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setSelectedId(provider.id);
                  }}
                >
                  <Flexbox horizontal justify="space-between">
                    <Text strong>{provider.displayName}</Text>
                    <Tag>{provider.status}</Tag>
                  </Flexbox>
                  <Text type="secondary">
                    {provider.providerKey} · rev {provider.revision}
                  </Text>
                </button>
              ))
            )}
          </div>
          {creating || selected ? (
            <IdentityProviderWizard
              authMethod={authMethod ?? null}
              callbacks={callbacks.data}
              canCreate={canCreate}
              canPublish={canPublish}
              canTest={canTest}
              canUpdate={canUpdate}
              key={creating ? 'new' : `${selected?.id}:${selected?.revision}`}
              provider={creating ? undefined : selected}
              onSaved={async () => {
                setCreating(false);
                await providers.mutate();
              }}
            />
          ) : null}
        </div>
      )}
    </AdminPageTemplate>
  );
});

IdentityProviderPage.displayName = 'IdentityProviderPage';
export default IdentityProviderPage;
