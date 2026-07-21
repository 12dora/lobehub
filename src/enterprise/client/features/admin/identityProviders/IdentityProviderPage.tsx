'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { requestAdminReauth } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { openReasonModal } from '../users/modals/openReasonModal';
import {
  createIdentityProviderDraftFromTemplate,
  type IdentityProviderCreateDraftSeed,
  type IdentityProviderCreateTemplateId,
  isIdentityProviderSetupGuidanceError,
} from './controller';
import EasyauthStatusCard from './EasyauthStatusCard';
import IdentityProviderList from './IdentityProviderList';
import IdentityProviderRuntimeCard from './IdentityProviderRuntimeCard';
import IdentityProviderSetupGuidance from './IdentityProviderSetupGuidance';
import IdentityProviderTypePicker from './IdentityProviderTypePicker';
import IdentityProviderWizard from './IdentityProviderWizard';
import { identityProviderStyles as styles } from './styles';
import { useIdentityProviderRestartLifecycle } from './useIdentityProviderRestartLifecycle';
import {
  useAuthSnapshotStatus,
  useEasyauthStatus,
  useIdentityProviderCallbacks,
  useIdentityProviders,
} from './useIdentityProviders';

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
  const mutateProviders = providers.mutate;
  const callbacks = useIdentityProviderCallbacks(enabled);
  const easyauth = useEasyauthStatus(enabled);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createSeed, setCreateSeed] = useState<IdentityProviderCreateDraftSeed | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [restartError, setRestartError] = useState<string | null>(null);
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
  const selected = useMemo(
    () => providers.data?.items.find((item) => item.id === selectedId) ?? providers.data?.items[0],
    [providers.data?.items, selectedId],
  );

  const refreshProviders = useCallback(() => mutateProviders(), [mutateProviders]);
  const discardAndReload = useCallback(() => {
    setEditorDirty(false);
    setEditorEpoch((current) => current + 1);
    void mutateProviders();
  }, [mutateProviders]);
  const changeEditor = useCallback(
    (change: () => void) => {
      if (!editorDirty) {
        change();
        return;
      }
      confirmModal({
        cancelText: t('identityProviders.unsaved.stay'),
        content: t('identityProviders.unsaved.description'),
        okText: t('identityProviders.unsaved.discard'),
        title: t('identityProviders.unsaved.title'),
        onOk: () => {
          setEditorDirty(false);
          setEditorEpoch((current) => current + 1);
          change();
        },
      });
    },
    [editorDirty, t],
  );

  useEffect(() => {
    setRestartPolling(restartLifecycle.phase === 'accepted');
  }, [restartLifecycle.phase]);

  const startCreate = useCallback(() => {
    changeEditor(() => {
      setCreating(true);
      setCreateSeed(null);
      setSelectedId(null);
    });
  }, [changeEditor]);

  const pickTemplate = useCallback((type: IdentityProviderCreateTemplateId) => {
    setCreateSeed(createIdentityProviderDraftFromTemplate(type));
    setEditorEpoch((current) => current + 1);
  }, []);

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
                if (restartLifecycle.accept(prepared, result)) {
                  await runtime.mutate().catch(() => undefined);
                  toast.success(t('identityProviders.restart.accepted'));
                } else {
                  throw new Error('restart acceptance mismatch');
                }
              } catch (cause) {
                restartLifecycle.fail();
                setRestartError(t('identityProviders.errors.generic'));
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

  const showCreateAction = canCreate && !setupGuidance;
  const showRuntime = canRestart && !setupGuidance;
  const showEditor = creating || Boolean(selected);

  return (
    <AdminPageTemplate
      description={t('identityProviders.description')}
      title={t('identityProviders.title')}
      actions={
        setupGuidance ? null : (
          <Flexbox horizontal gap={8}>
            {showCreateAction ? (
              <Button type="primary" onClick={startCreate}>
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
              restartLifecycle.attempt
                ? t('identityProviders.restart.failedAccepted', {
                    requestId: restartLifecycle.attempt.requestId,
                    revision: restartLifecycle.attempt.targetIdentityRevision,
                  })
                : t('identityProviders.restart.failed')
            }
          />
        ) : null
      }
    >
      <div className={styles.stack}>
        {!setupGuidance ? (
          <EasyauthStatusCard
            data={easyauth.data}
            error={Boolean(easyauth.error)}
            loading={easyauth.isLoading}
            onRetry={() => void easyauth.mutate()}
          />
        ) : null}

        {setupGuidance ? (
          <IdentityProviderSetupGuidance />
        ) : (
          <>
            {showRuntime ? (
              <IdentityProviderRuntimeCard
                loadError={Boolean(runtime.error && !runtime.data)}
                restartError={restartError}
                status={runtime.data}
                onRetry={() => void runtime.mutate()}
              />
            ) : null}

            {/*
              Keep the create/edit column mounted while the list revalidates.
              isLoading flips true on retry / SWR backoff even when creating;
              unmounting would discard wizard input (including write-only secrets).
            */}
            {providers.isLoading && !creating ? (
              <Text role="status">{t('identityProviders.loading')}</Text>
            ) : (
              <div className={styles.columns}>
                <Flexbox gap={8}>
                  {providers.isLoading && creating ? (
                    <Text role="status">{t('identityProviders.loading')}</Text>
                  ) : null}
                  {providers.error ? (
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
                  ) : null}
                  {!providers.isLoading || creating ? (
                    <IdentityProviderList
                      canCreate={canCreate}
                      items={providers.data?.items ?? []}
                      selectedId={creating ? null : (selected?.id ?? null)}
                      onCreate={startCreate}
                      onSelect={(id) =>
                        changeEditor(() => {
                          setCreating(false);
                          setCreateSeed(null);
                          setSelectedId(id);
                        })
                      }
                    />
                  ) : null}
                </Flexbox>

                {/* Wizard stays reachable even when list fails — required for "New". */}
                {creating && !createSeed ? (
                  <IdentityProviderTypePicker onSelect={pickTemplate} />
                ) : showEditor && (creating ? Boolean(createSeed) : Boolean(selected)) ? (
                  <Flexbox gap={8}>
                    {callbacks.error ? (
                      <Alert
                        showIcon
                        description={t('identityProviders.callback.loadError')}
                        type="warning"
                        action={
                          <Button size="small" onClick={() => void callbacks.mutate()}>
                            {t('identityProviders.actions.retry')}
                          </Button>
                        }
                      />
                    ) : null}
                    <IdentityProviderWizard
                      authMethod={authMethod ?? null}
                      callbacks={callbacks.data}
                      canCreate={canCreate}
                      canPublish={canPublish}
                      canTest={canTest}
                      canUpdate={canUpdate}
                      createSeed={creating ? (createSeed ?? undefined) : undefined}
                      key={`${creating ? `new:${createSeed?.type ?? 'pick'}` : selected?.id}:${editorEpoch}`}
                      provider={creating ? undefined : selected}
                      onDirtyChange={setEditorDirty}
                      onDiscard={discardAndReload}
                      onRefresh={refreshProviders}
                      onSaved={async () => {
                        setCreating(false);
                        setCreateSeed(null);
                        await mutateProviders();
                      }}
                    />
                  </Flexbox>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </AdminPageTemplate>
  );
});

IdentityProviderPage.displayName = 'IdentityProviderPage';
export default IdentityProviderPage;
