'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { Alert, Flexbox, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import DataTable from '../primitives/DataTable';
import { useCursorStack } from '../skills/useCursorPagedList';
import {
  isIdentityProviderDeletable,
  isIdentityProviderDisableable,
  isIdentityProviderSetupGuidanceError,
  type PublishedHistorySignal,
  resolvePublishedHistorySignal,
} from './controller';
import {
  buildIdentityProviderActionsColumn,
  buildIdentityProviderColumns,
} from './identityProviderColumns';
import { IdentityProviderRestartBanner } from './IdentityProviderRestartBanner';
import IdentityProviderSetupGuidance from './IdentityProviderSetupGuidance';
import { openIdentityProviderWizardModal } from './openIdentityProviderWizardModal';
import { identityProviderStyles as styles } from './styles';
import { useIdentityProviderRestartAction } from './useIdentityProviderRestartAction';
import { useIdentityProviderRestartLifecycle } from './useIdentityProviderRestartLifecycle';
import { useIdentityProviderRowActions } from './useIdentityProviderRowActions';
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
  const canDelete = permissions.includes(PLATFORM_PERMISSIONS.IDENTITY_DELETE);
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

  /**
   * Published-history for draft heads — server-batched on list items (ASI-005).
   * Prior live configs remain tombstoneable after edit/secret-clear.
   * Missing field (older cache / mutation payload) → `unknown` (fail safe).
   */
  const publishedHistoryById = useMemo(() => {
    const items = providers.data?.items ?? [];
    const next: Record<string, PublishedHistorySignal> = {};
    for (const item of items) {
      if (item.status !== 'draft') continue;
      if (typeof item.hasPublishedHistory === 'boolean') {
        next[item.id] = item.hasPublishedHistory ? 'has-history' : 'no-history';
      } else {
        next[item.id] = 'unknown';
      }
    }
    return next;
  }, [providers.data?.items]);

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

  /**
   * Disable (tombstone): live statuses, drafts with published history, or drafts whose
   * history is unknown (loading/error — fail safe toward revocation).
   * Confirmed never-published drafts must use Delete (backend rejects Disable).
   */
  const isDisableable = useCallback(
    (provider: PlatformIdentityProviderDraft) =>
      isIdentityProviderDisableable(
        provider,
        resolvePublishedHistorySignal(publishedHistoryById, provider.id),
      ),
    [publishedHistoryById],
  );

  /** Hard delete only when draft is confirmed never-published (not unknown). */
  const isDeletable = useCallback(
    (provider: PlatformIdentityProviderDraft) =>
      isIdentityProviderDeletable(
        provider,
        resolvePublishedHistorySignal(publishedHistoryById, provider.id),
      ),
    [publishedHistoryById],
  );

  const { requestDelete, requestDisable } = useIdentityProviderRowActions({
    authMethod,
    canDelete,
    canDisable,
    isDeletable,
    isDisableable,
    refreshProviders,
    runtime,
    t,
  });

  const { requestRestart } = useIdentityProviderRestartAction({
    authMethod,
    restartLifecycle,
    runtime,
    t,
  });

  const columns = useMemo(() => buildIdentityProviderColumns(t), [t]);

  if (!canRead) {
    return <Alert showIcon description={t('identityProviders.errors.forbidden')} type="warning" />;
  }

  // Create immediately becomes update after the first persist, so New requires both.
  const showCreateAction = canCreate && canUpdate && !setupGuidance;
  const showCreateNeedsUpdate = canCreate && !canUpdate && !setupGuidance;
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
            ) : showCreateNeedsUpdate ? (
              <Tooltip title={t('identityProviders.actions.createNeedsUpdate')}>
                <span>
                  <Button disabled type="primary">
                    {t('identityProviders.actions.create')}
                  </Button>
                </span>
              </Tooltip>
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
        setupGuidance ? null : restartLifecycle.phase === 'idle' ? null : (
          <IdentityProviderRestartBanner
            phase={restartLifecycle.phase}
            resultCategory={runtime.data?.restartRequest?.resultCategory}
            t={t}
            onRetry={() => restartLifecycle.retry(requestRestart)}
          />
        )
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
              ...(canDisable || canDelete
                ? [
                    buildIdentityProviderActionsColumn({
                      canDelete,
                      canDisable,
                      isDeletable,
                      isDisableable,
                      requestDelete,
                      requestDisable,
                      t,
                    }),
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
