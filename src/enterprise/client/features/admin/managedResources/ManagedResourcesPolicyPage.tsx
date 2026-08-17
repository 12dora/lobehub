'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { MANAGED_RESOURCE_NAV_LABEL_KEY } from './controller';
import { useManagedResourcePolicyEditor } from './hooks/useManagedResourcePolicyEditor';
import { managedResourcePolicyCardStyles } from './policyCardStyles';
import PolicyModeGrid from './PolicyModeGrid';
import { policyPageStyles } from './policyPageStyles';
import SharedOAuthAuthorizationControl from './SharedOAuthAuthorizationControl';

const ManagedResourcesPolicyPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const {
    actionError,
    canAccessSurface,
    canEditPolicy,
    canReadConnectorGovernance,
    canSave,
    canUpdateConnectorGovernance,
    canUpdateSidebarLayout,
    canView,
    conflictState,
    data,
    draft,
    editorsLocked,
    error,
    handleSave,
    hasChanges,
    isLoading,
    mutate,
    readinessBlocked,
    readinessBlockedResources,
    reloadAfterStaleBase,
    saveState,
    setConflictState,
    updateUiMode,
  } = useManagedResourcePolicyEditor({ embedded });

  const renderPolicySection = () => {
    if (!canView) return null;
    if (!draft) return <Loading debugId="AdminManagedResources > Hydrate" />;

    return (
      <>
        {!canSave ? <Alert showIcon message={t('managedResources.readOnly')} type="info" /> : null}

        <PolicyModeGrid
          canEditPolicy={canEditPolicy}
          canReadConnectorGovernance={canReadConnectorGovernance}
          canUpdateConnectorGovernance={canUpdateConnectorGovernance}
          canUpdateSidebarLayout={canUpdateSidebarLayout}
          draft={draft}
          editorsLocked={editorsLocked}
          onModeChange={updateUiMode}
        />

        {readinessBlocked ? (
          <Alert
            showIcon
            type="warning"
            message={t('managedResources.readiness.blocked', {
              resources: readinessBlockedResources
                .map((resource) => t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never))
                .join(', '),
            })}
          />
        ) : null}

        <div className={policyPageStyles.footer}>
          <Flexbox gap={4}>
            <span className={policyPageStyles.status}>
              {t(`managedResources.saveState.${saveState}` as never)}
            </span>
            {actionError ? <Text type="danger">{actionError}</Text> : null}
          </Flexbox>
          {canSave ? (
            <Button
              disabled={!hasChanges || readinessBlocked}
              loading={saveState === 'saving'}
              type="primary"
              onClick={() => void handleSave()}
            >
              {t('managedResources.actions.save')}
            </Button>
          ) : null}
        </div>
      </>
    );
  };

  /** Connector-only admins still reach the shared-OAuth control without POLICY_READ. */
  const renderConnectorOnlySection = () => {
    if (canView || !canReadConnectorGovernance) return null;
    return (
      <div className={policyPageStyles.grid}>
        <section className={managedResourcePolicyCardStyles.card}>
          <div className={managedResourcePolicyCardStyles.row}>
            <Text strong style={{ flex: 1, minWidth: 0 }}>
              {t(MANAGED_RESOURCE_NAV_LABEL_KEY.connectors as never)}
            </Text>
          </div>
          <SharedOAuthAuthorizationControl
            canRead={canReadConnectorGovernance}
            canUpdate={canUpdateConnectorGovernance}
          />
        </section>
      </div>
    );
  };

  const body = (
    <AdminPageTemplate
      hideTitle={embedded}
      title={t('managedResources.title')}
      banner={
        <>
          {conflictState === 'reloaded' ? (
            <Alert
              closable
              showIcon
              message={t('managedResources.conflict.reloaded')}
              type="warning"
              onClose={() => setConflictState('none')}
            />
          ) : null}
          {conflictState === 'reloadFailed' ? (
            <Alert
              showIcon
              description={t('managedResources.conflict.reloadFailedDesc')}
              message={t('managedResources.conflict.reloadFailed')}
              type="warning"
              extra={
                <Button onClick={() => void reloadAfterStaleBase()}>
                  {t('managedResources.conflict.retryReload')}
                </Button>
              }
            />
          ) : null}
        </>
      }
    >
      {renderPolicySection()}
      {renderConnectorOnlySection()}
    </AdminPageTemplate>
  );

  if (!canAccessSurface) {
    return (
      <AdminPageTemplate hideTitle={embedded} title={t('managedResources.title')}>
        <Alert showIcon message={t('page.forbidden.desc')} type="warning" />
      </AdminPageTemplate>
    );
  }

  // Connector-only: no policy fetch — render governance control directly.
  if (!canView) {
    return body;
  }

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminManagedResources" />}
      onRetry={() => void mutate()}
    >
      {data ? body : null}
    </AsyncBoundary>
  );
});

ManagedResourcesPolicyPage.displayName = 'ManagedResourcesPolicyPage';

export default ManagedResourcesPolicyPage;
