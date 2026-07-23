'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { requestAdminReauth } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import StatusBadge from '../primitives/StatusBadge';
import { useCursorStack } from '../skills/useCursorPagedList';
import { openReasonModal } from '../users/modals/openReasonModal';
import { isIdentityProviderSetupGuidanceError, toIdentityProviderStatusBadge } from './controller';
import IdentityProviderSetupGuidance from './IdentityProviderSetupGuidance';
import { openIdentityProviderWizardModal } from './openIdentityProviderWizardModal';
import { identityProviderStyles as styles } from './styles';
import { useIdentityProviderRestartLifecycle } from './useIdentityProviderRestartLifecycle';
import { useAuthSnapshotStatus, useIdentityProviders } from './useIdentityProviders';

const IdentityProviderPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions, status: accessStatus } = useAdminAccess();
  const canRead = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_READ);
  const canCreate = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_CREATE);
  const canUpdate = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_UPDATE);
  const canTest = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_TEST);
  const canPublish = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_PUBLISH);
  const canDisable = canPublish;
  const canRestart = permissions.includes(PLATFORM_PERMISSIONS.OIDC_PUBLISH);
  const enabled = accessStatus === 'allowed' && canRead;
  const { cursor, goNext, goPrevious, hasPrevious } = useCursorStack('identity-providers');
  const providers = useIdentityProviders(enabled, cursor);
  const mutateProviders = providers.mutate;
  const runtimeEnabled = accessStatus === 'allowed' && canRestart;
  const [restartPolling, setRestartPolling] = useState(false);
  const runtime = useAuthSnapshotStatus(runtimeEnabled, restartPolling);
  const restartLifecycle = useIdentityProviderRestartLifecycle({
    error: runtime.error,
    status: runtime.data,
  });
  const setupGuidance = Boolean(
    providers.error && isIdentityProviderSetupGuidanceError(providers.error),
  );

  const refreshProviders = useCallback(() => mutateProviders(), [mutateProviders]);

  useEffect(() => {
    setRestartPolling(restartLifecycle.phase === 'accepted');
  }, [restartLifecycle.phase]);

  const openWizard = useCallback(
    (provider?: PlatformIdentityProviderDraft) => {
      openIdentityProviderWizardModal({
        authMethod: authMethod ?? null,
        canCreate,
        canPublish,
        canTest,
        canUpdate,
        onChanged: refreshProviders,
        provider,
      });
    },
    [authMethod, canCreate, canPublish, canTest, canUpdate, refreshProviders],
  );

  const requestDisable = useCallback(
    (provider: PlatformIdentityProviderDraft) => {
      if (!canDisable) return;
      if (
        provider.status !== 'active' &&
        provider.status !== 'pending_restart' &&
        provider.status !== 'published' &&
        provider.status !== 'error'
      ) {
        return;
      }
      confirmModal({
        cancelText: t('identityProviders.disable.cancel', {
          defaultValue: 'Cancel',
        }),
        content: t('identityProviders.disable.impact', {
          defaultValue:
            'This publishes a signed tombstone revision. The provider will stop accepting logins after instances reload. This cannot be undone without republishing a new configuration.',
        }),
        okButtonProps: { danger: true },
        okText: t('identityProviders.disable.confirm', { defaultValue: 'Disable provider' }),
        title: t('identityProviders.disable.title', { defaultValue: 'Disable identity provider' }),
        onOk: async () => {
          try {
            await requestAdminReauth({ authMethod });
            openReasonModal({
              authMethod,
              buildPayload: (reason) => ({ reason }),
              danger: true,
              impact: t('identityProviders.disable.impact', {
                defaultValue:
                  'This publishes a signed tombstone revision. The provider will stop accepting logins after instances reload.',
              }),
              onSubmit: async (payload) => {
                const { reason } = payload as { reason: string };
                await adminIdentityProvidersService.disable({
                  expectedRevision: provider.revision,
                  id: provider.id,
                  reason,
                });
                await refreshProviders();
                toast.success(
                  t('identityProviders.disable.success', {
                    defaultValue: 'Provider disabled',
                  }),
                );
              },
              submitLabel: t('identityProviders.disable.confirm', {
                defaultValue: 'Disable provider',
              }),
              targetLabel: provider.displayName,
              title: t('identityProviders.disable.title', {
                defaultValue: 'Disable identity provider',
              }),
            });
          } catch {
            toast.error(t('identityProviders.errors.generic', { defaultValue: 'Request failed' }));
          }
        },
      });
    },
    [authMethod, canDisable, refreshProviders, t],
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
              try {
                const prepared = await adminIdentityProvidersService.prepareRestart(input);
                const result = await adminIdentityProvidersService.requestRestart({
                  ...input,
                  intentToken: prepared.intentToken,
                });
                if (restartLifecycle.accept(prepared, result)) {
                  await runtime.mutate().catch(() => undefined);
                  toast.success(t('identityProviders.restart.accepted'));
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
        } catch {
          toast.error(t('identityProviders.restart.reauthFailed'));
        }
      },
    });
  };

  const columns = useMemo<TableColumnsType<PlatformIdentityProviderDraft>>(
    () => [
      {
        key: 'name',
        title: t('identityProviders.columns.name'),
        render: (_, item) => (
          <Flexbox gap={2}>
            <Text strong>{item.displayName}</Text>
            <Text ellipsis style={{ fontSize: 12 }} type="secondary">
              {item.buttonLabel}
            </Text>
          </Flexbox>
        ),
      },
      {
        key: 'type',
        title: t('identityProviders.columns.type'),
        width: 160,
        render: (_, item) => (
          <Tag color={item.type === 'authentik' ? 'blue' : 'default'}>
            {item.type === 'authentik'
              ? 'Authentik'
              : t('identityProviders.templates.genericOidc.label')}
          </Tag>
        ),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('identityProviders.columns.status'),
        width: 150,
        render: (_, item) => <StatusBadge status={toIdentityProviderStatusBadge(item.status)} />,
      },
    ],
    [t],
  );

  if (!canRead) {
    return <Alert showIcon description={t('identityProviders.errors.forbidden')} type="warning" />;
  }

  const showCreateAction = canCreate && !setupGuidance;
  const showRuntime = canRestart && !setupGuidance;

  return (
    <AdminPageTemplate
      description={t('identityProviders.description')}
      hideTitle={embedded}
      title={t('identityProviders.title')}
      actions={
        setupGuidance ? null : (
          <Flexbox horizontal gap={8}>
            {showCreateAction ? (
              <Button type="primary" onClick={() => openWizard()}>
                {t('identityProviders.actions.create')}
              </Button>
            ) : null}
            {showRuntime && runtime.data?.pendingRestart && runtime.data.restart.supported ? (
              <Button danger onClick={requestRestart}>
                {t('identityProviders.actions.restart')}
              </Button>
            ) : null}
          </Flexbox>
        )
      }
      banner={
        setupGuidance ? null : restartLifecycle.phase === 'accepted' ? (
          <Alert showIcon description={t('identityProviders.restart.reconnecting')} type="info" />
        ) : restartLifecycle.phase === 'activated' ? (
          <Alert showIcon description={t('identityProviders.restart.activated')} type="success" />
        ) : restartLifecycle.phase === 'failed' ? (
          <Alert
            showIcon
            type="error"
            action={
              <Button size="small" onClick={() => restartLifecycle.retry(requestRestart)}>
                {t('identityProviders.actions.retry')}
              </Button>
            }
            description={
              runtime.data?.restartRequest?.resultCategory
                ? t('identityProviders.restart.failedWithCategory', {
                    category: runtime.data.restartRequest.resultCategory,
                    defaultValue: `Restart failed (${runtime.data.restartRequest.resultCategory})`,
                  })
                : t('identityProviders.restart.failed')
            }
          />
        ) : null
      }
    >
      <div className={styles.stack}>
        {setupGuidance ? (
          <IdentityProviderSetupGuidance />
        ) : (
          <DataTable<PlatformIdentityProviderDraft>
            dataSource={providers.data?.items ?? []}
            emptyDescription={t('identityProviders.empty')}
            error={Boolean(providers.error) && !providers.data}
            loading={providers.isLoading && !providers.data}
            pagination={false}
            rowKey="id"
            columns={[
              ...columns,
              ...(canDisable
                ? [
                    {
                      key: 'actions',
                      title: t('identityProviders.columns.actions', { defaultValue: 'Actions' }),
                      width: 120,
                      render: (_: unknown, item: PlatformIdentityProviderDraft) => {
                        const disableable =
                          item.status === 'active' ||
                          item.status === 'pending_restart' ||
                          item.status === 'published' ||
                          item.status === 'error';
                        if (!disableable) return null;
                        return (
                          <Button
                            danger
                            size="small"
                            onClick={(event) => {
                              event.stopPropagation();
                              requestDisable(item);
                            }}
                          >
                            {t('identityProviders.actions.disable', { defaultValue: 'Disable' })}
                          </Button>
                        );
                      },
                    } as TableColumnsType<PlatformIdentityProviderDraft>[number],
                  ]
                : []),
            ]}
            cursorPagination={{
              hasNext:
                Boolean(providers.data?.nextCursor) && !providers.error && !providers.isLoading,
              hasPrevious: hasPrevious && !providers.isLoading,
              onNext: () => {
                const next = providers.data?.nextCursor;
                if (!next || providers.isLoading) return;
                goNext(next);
              },
              onPrevious: () => {
                if (providers.isLoading) return;
                goPrevious();
              },
            }}
            onRetry={() => void providers.mutate()}
            onRowActivate={(item) => openWizard(item)}
          />
        )}
      </div>
    </AdminPageTemplate>
  );
});

IdentityProviderPage.displayName = 'IdentityProviderPage';
export default IdentityProviderPage;
