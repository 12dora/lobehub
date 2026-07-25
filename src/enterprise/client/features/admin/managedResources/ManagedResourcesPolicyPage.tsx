'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import debug from 'debug';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockerFunction } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminManagedResourcesService } from '@/enterprise/client/services/adminManagedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';
import { publishManagedResourcePolicy, saveManagedResourceDraft } from './actions';
import {
  buildManagedResourceDiff,
  deriveManagedResourcePermissions,
  fromManagedResourceUiMode,
  getUnreadyEnforcedResources,
  MANAGED_RESOURCE_NAV_LABEL_KEY,
  type ManagedResourceFailedOperation,
  type ManagedResourceSaveState,
  type ManagedResourceUiMode,
  normalizeManagedResourcePolicyMap,
  rebaseManagedResourceDraft,
  resolveManagedResourcePrimaryAction,
  shouldPreserveLocalDraftAfterSave,
  toManagedResourceUiMode,
} from './controller';
import { useFetchAdminManagedResources } from './hooks/useAdminManagedResources';
import { managedResourcePolicyCardStyles, POLICY_MODE_SELECT_WIDTH } from './policyCardStyles';
import SharedOAuthAuthorizationControl from './SharedOAuthAuthorizationControl';
import SidebarLayoutControl from './SidebarLayoutControl';

const log = debug('lobe-client:admin:managed-resources');

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
  grid: css`
    display: grid;

    /* Equal-height rows so every managed-resource box lines up as a uniform tile. */
    grid-auto-rows: 1fr;

    /* Cards stay readable; do not force all boxes into one cramped row. 320px leaves room
       for the title next to the fixed-width mode select so long labels don't truncate. */
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  `,
  status: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const UI_MODE_VALUES = ['user', 'platform'] as const satisfies readonly ManagedResourceUiMode[];

const ManagedResourcesPolicyPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const platform = useEnterprisePlatform();
  const { canPublish, canUpdate, canView } = deriveManagedResourcePermissions(permissions);
  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  // Nested controls have independent procedure gates — do not inherit canSave.
  const canUpdateSidebarLayout = permissionSet.has(PLATFORM_PERMISSIONS.POLICY_UPDATE);
  const canReadConnectorGovernance = permissionSet.has(PLATFORM_PERMISSIONS.CONNECTOR_READ);
  const canUpdateConnectorGovernance = permissionSet.has(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE);
  // Parent surface is reachable for policy OR connector governance (not POLICY_READ only).
  const canAccessSurface = canView || canReadConnectorGovernance;

  const { data, error, isLoading, mutate } = useFetchAdminManagedResources(canView);

  const [draft, setDraft] = useState<ManagedResourcePolicyMap | null>(null);
  const [published, setPublished] = useState<ManagedResourcePolicyMap | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<ManagedResourceSaveState>('idle');
  const [failedOperation, setFailedOperation] = useState<ManagedResourceFailedOperation | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const [baseRevision, setBaseRevision] = useState(0);
  const hydratedRef = useRef(false);
  /** Last clean server draft used as the three-way-merge base for conflict rebase. */
  const baseDraftRef = useRef<ManagedResourcePolicyMap | null>(null);
  /**
   * Monotonic local-edit epoch. Bumped on every user draft change; captured at save
   * submit so a successful response never overwrites newer in-flight local edits
   * (even if a race slips past the saving lock before re-render).
   */
  const draftEpochRef = useRef(0);

  const shouldBlockPageExit = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
    [dirty],
  );
  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('managedResources.unsavedStay'),
      content: t('managedResources.unsavedLeave'),
      okText: t('managedResources.unsavedConfirm'),
      title: t('managedResources.unsavedTitle'),
    }),
    [t],
  );
  useUnsavedChangesGuard({
    enabled: dirty,
    messages: unsavedMessages,
    shouldBlock: shouldBlockPageExit,
  });

  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    setDraft(data.draft);
    setPublished(data.published);
    setActiveDraftToken(data.draftToken);
    setBaseRevision(data.baseRevision);
    baseDraftRef.current = data.draft;
    setDirty(false);
    setSaveState('idle');
    setFailedOperation(null);
    setConflict(false);
  }, [data]);

  const editorsLocked = saveState === 'saving' || conflict;
  const canEditPolicy = canUpdate && !editorsLocked;

  const updateUiMode = useCallback(
    (resource: ManagedResourceKind, mode: ManagedResourceUiMode) => {
      if (!canUpdate || editorsLocked) return;
      const next = fromManagedResourceUiMode(mode);
      draftEpochRef.current += 1;
      setDraft((current) => (current ? { ...current, [resource]: next } : current));
      setDirty(true);
      setSaveState('dirty');
      setFailedOperation(null);
      setActionError(null);
    },
    [canUpdate, editorsLocked],
  );

  const unready = useMemo(
    () =>
      data && draft
        ? // Evaluate readiness against the canonical platform-managed form so historical
          // true+ui-only (shown as platform) still requires catalog readiness before publish.
          getUnreadyEnforcedResources(normalizeManagedResourcePolicyMap(draft), data.readiness)
        : [],
    [data, draft],
  );

  const hasChanges = useMemo(() => {
    if (!draft || !published) return false;
    return (
      buildManagedResourceDiff(
        normalizeManagedResourcePolicyMap(published),
        normalizeManagedResourcePolicyMap(draft),
      ).length > 0
    );
  }, [draft, published]);

  const primaryAction = resolveManagedResourcePrimaryAction({
    canPublish,
    canUpdate,
    conflict,
    dirty,
    failedOperation,
    hasChanges,
    publishReady: unready.length === 0,
    saveState,
  });

  const enterConflict = useCallback(() => {
    setConflict(true);
    setSaveState('failed');
    setActionError(t('managedResources.conflict.desc'));
  }, [t]);

  // Refetch the authoritative policy and rebaseline (discards local edits — used after a conflict).
  const handleRefresh = useCallback(async () => {
    setActionError(null);
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_MANAGED_POLICY_UNAVAILABLE');
      draftEpochRef.current += 1;
      setDraft(latest.draft);
      setPublished(latest.published);
      setActiveDraftToken(latest.draftToken);
      setBaseRevision(latest.baseRevision);
      baseDraftRef.current = latest.draft;
      setDirty(false);
      setSaveState('idle');
      setFailedOperation(null);
      setConflict(false);
    } catch {
      setActionError(t('managedResources.errors.refresh'));
    }
  }, [mutate, t]);

  /**
   * Acknowledge local-wins values after a conflict (or post-rebase field conflict)
   * and unlock the editor so the admin can review and save.
   */
  const handleKeepLocal = useCallback(() => {
    setConflict(false);
    setActionError(null);
    setFailedOperation(null);
    // Local draft remains; mark dirty so save is available after unlock.
    setDirty(true);
    setSaveState('dirty');
  }, []);

  /** Three-way merge local edits onto the latest server draft after a revision conflict. */
  const handleRebase = useCallback(async () => {
    if (!draft) return;
    setActionError(null);
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_MANAGED_POLICY_UNAVAILABLE');
      const original = baseDraftRef.current ?? latest.draft;
      const rebased = rebaseManagedResourceDraft({
        latest: latest.draft,
        local: draft,
        original,
      });
      draftEpochRef.current += 1;
      setDraft(rebased.draft);
      setPublished(latest.published);
      setActiveDraftToken(latest.draftToken);
      setBaseRevision(latest.baseRevision);
      baseDraftRef.current = latest.draft;
      setDirty(true);
      setSaveState('dirty');
      setFailedOperation(null);
      if (rebased.conflicts.length > 0) {
        // Local values already win for divergent fields; stay in conflict mode until
        // the admin explicitly keeps them (unlocks) or discards.
        setActionError(t('managedResources.conflict.fields'));
        return;
      }
      setConflict(false);
    } catch {
      setActionError(t('managedResources.errors.refresh'));
    }
  }, [draft, mutate, t]);

  const mapActionError = useCallback(
    (cause: unknown, operation: ManagedResourceFailedOperation) => {
      const mapped = mapEnterpriseError(cause);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        setFailedOperation(operation);
        enterConflict();
        return true;
      }
      setSaveState('failed');
      setFailedOperation(operation);
      setActionError(
        mapped
          ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
          : t('managedResources.errors.generic'),
      );
      return false;
    },
    [enterConflict, t],
  );

  /** Persist the local draft only (does not publish). Readiness gates publish, not draft save. */
  const handleSave = useCallback(async () => {
    if (!data || !draft || !canUpdate || conflict || saveState === 'saving') {
      return;
    }
    const reason = t('managedResources.saveReason');
    const normalizedDraft = normalizeManagedResourcePolicyMap(draft);
    // Epoch at submit: any later user edit bumps draftEpochRef and must not be clobbered.
    const submittedEpoch = draftEpochRef.current;
    setSaveState('saving');
    setActionError(null);
    try {
      const saved = await saveManagedResourceDraft({
        input: { draft: normalizedDraft, expectedDraftToken: activeDraftToken, reason },
        saveDraft: adminManagedResourcesService.saveDraft,
      });
      setActiveDraftToken(saved.draftToken);
      setBaseRevision(saved.baseRevision);
      // Server now holds the submitted snapshot as the clean draft base.
      baseDraftRef.current = normalizedDraft;
      setFailedOperation(null);

      // Concurrent local edits made after submit (or that raced the saving lock): keep them.
      if (shouldPreserveLocalDraftAfterSave(submittedEpoch, draftEpochRef.current)) {
        setDirty(true);
        setSaveState('dirty');
        setActionError(t('managedResources.errors.savedWithLocalEdits'));
        return;
      }

      setDraft(normalizedDraft);
      setDirty(false);
      setSaveState('saved');
      // Soft-refresh SWR cache without overwriting a still-dirty editor (already handled).
      try {
        const latest = await mutate();
        // Abort if the admin edited while refresh was in flight.
        if (shouldPreserveLocalDraftAfterSave(submittedEpoch, draftEpochRef.current)) {
          setDirty(true);
          setSaveState('dirty');
          setActionError(t('managedResources.errors.savedWithLocalEdits'));
          return;
        }
        if (latest) {
          setPublished(latest.published);
          setActiveDraftToken(latest.draftToken);
          setBaseRevision(latest.baseRevision);
          baseDraftRef.current = latest.draft;
        }
      } catch (refreshError) {
        log('post-save refresh failed: %O', refreshError);
        setActionError(t('managedResources.errors.savedRefreshFailed'));
      }
    } catch (cause) {
      mapActionError(cause, 'save');
    }
  }, [activeDraftToken, canUpdate, conflict, data, draft, mapActionError, mutate, saveState, t]);

  /** Publish the already-persisted draft (stranded draft recovery / explicit publish). */
  const handlePublish = useCallback(async () => {
    if (
      !draft ||
      !canPublish ||
      dirty ||
      conflict ||
      unready.length > 0 ||
      saveState === 'saving'
    ) {
      return;
    }
    const reason = t('managedResources.saveReason');
    // Epoch at submit: post-publish SWR refresh must not clobber edits made while refresh is in flight.
    const submittedEpoch = draftEpochRef.current;
    setSaveState('saving');
    setActionError(null);
    try {
      const { capabilityRefreshFailed } = await publishManagedResourcePolicy({
        authMethod: authMethod ?? null,
        input: {
          expectedDraftToken: activeDraftToken,
          expectedRevision: baseRevision,
          reason,
        },
        publish: adminManagedResourcesService.publish,
        refreshCapabilities: platform.refresh,
      });
      setDirty(false);
      setSaveState('saved');
      setFailedOperation(null);
      setPublished(normalizeManagedResourcePolicyMap(draft));
      if (capabilityRefreshFailed) {
        setActionError(t('managedResources.errors.publishedRefreshFailed'));
      }
      try {
        const latest = await mutate();
        // Abort applying refreshed draft if the admin edited while refresh was in flight.
        if (shouldPreserveLocalDraftAfterSave(submittedEpoch, draftEpochRef.current)) {
          setDirty(true);
          setSaveState('dirty');
          setActionError(t('managedResources.errors.savedWithLocalEdits'));
          return;
        }
        if (latest) {
          setDraft(latest.draft);
          setPublished(latest.published);
          setActiveDraftToken(latest.draftToken);
          setBaseRevision(latest.baseRevision);
          baseDraftRef.current = latest.draft;
        }
      } catch (refreshError) {
        log('post-publish SWR refresh failed: %O', refreshError);
        // Prefer capability-refresh messaging if both failed; otherwise surface SWR failure.
        if (!capabilityRefreshFailed) {
          setActionError(t('managedResources.errors.publishedRefreshFailed'));
        }
      }
    } catch (cause) {
      mapActionError(cause, 'publish');
    }
  }, [
    activeDraftToken,
    authMethod,
    baseRevision,
    canPublish,
    conflict,
    dirty,
    draft,
    mapActionError,
    mutate,
    platform,
    saveState,
    t,
    unready.length,
  ]);

  const handlePrimaryAction = useCallback(() => {
    if (primaryAction === 'save' || primaryAction === 'retrySave') {
      void handleSave();
      return;
    }
    if (primaryAction === 'publish' || primaryAction === 'retryPublish') {
      void handlePublish();
    }
  }, [handlePublish, handleSave, primaryAction]);

  const primaryLabel =
    primaryAction === 'publish' || primaryAction === 'retryPublish'
      ? primaryAction === 'retryPublish'
        ? t('managedResources.actions.retryPublish')
        : t('managedResources.actions.publish')
      : primaryAction === 'retrySave'
        ? t('managedResources.actions.retrySave')
        : t('managedResources.actions.save');

  const renderPolicySection = () => {
    if (!canView) return null;
    if (!draft) return <Loading debugId="AdminManagedResources > Hydrate" />;

    const canEditResources = canUpdate;
    const draftPendingPublish = !dirty && hasChanges;

    return (
      <>
        {!canEditResources && !canPublish ? (
          <Alert showIcon message={t('managedResources.readOnly')} type="info" />
        ) : null}

        {draftPendingPublish ? (
          <Alert
            showIcon
            type="info"
            message={t('managedResources.draftPendingPublish', {
              defaultValue: 'A saved draft differs from the published policy. Publish to apply it.',
            })}
          />
        ) : null}

        <div className={styles.grid}>
          {MANAGED_RESOURCE_KINDS.map((resource) => {
            const item = draft[resource];
            const uiMode = toManagedResourceUiMode(item);
            return (
              <section className={managedResourcePolicyCardStyles.card} key={resource}>
                <div className={managedResourcePolicyCardStyles.row}>
                  <Text
                    strong
                    ellipsis={{ tooltip: true, tooltipWhenOverflow: true }}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never)}
                  </Text>
                  <Select
                    aria-label={`${t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never)} ${t('managedResources.uiMode.label')}`}
                    disabled={!canEditPolicy}
                    style={{ flexShrink: 0, width: POLICY_MODE_SELECT_WIDTH }}
                    value={uiMode}
                    options={UI_MODE_VALUES.map((mode) => ({
                      label: t(`managedResources.uiMode.${mode}` as never),
                      value: mode,
                    }))}
                    onChange={(mode) => updateUiMode(resource, mode as ManagedResourceUiMode)}
                  />
                </div>
                {resource === 'connectors' ? (
                  <SharedOAuthAuthorizationControl
                    canRead={canReadConnectorGovernance}
                    canUpdate={canUpdateConnectorGovernance}
                    disabled={editorsLocked}
                  />
                ) : null}
              </section>
            );
          })}

          <SidebarLayoutControl canUpdate={canUpdateSidebarLayout} disabled={editorsLocked} />
        </div>

        {unready.length > 0 ? (
          <Alert
            showIcon
            type="warning"
            message={t('managedResources.readiness.blocked', {
              resources: unready
                .map((resource) => t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never))
                .join(', '),
            })}
          />
        ) : null}

        <div className={styles.footer}>
          <Flexbox gap={4}>
            <span className={styles.status}>
              {t(`managedResources.saveState.${saveState}` as never)}
              {draftPendingPublish
                ? ` · ${t('managedResources.status.draftPending', {
                    defaultValue: 'Draft pending publish',
                  })}`
                : null}
            </span>
            {actionError ? <Text type="danger">{actionError}</Text> : null}
          </Flexbox>
          {primaryAction !== 'none' ? (
            <Button
              loading={saveState === 'saving'}
              type="primary"
              disabled={
                conflict ||
                ((primaryAction === 'publish' || primaryAction === 'retryPublish') &&
                  unready.length > 0)
              }
              onClick={handlePrimaryAction}
            >
              {primaryLabel}
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
      <div className={styles.grid}>
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
      description={t('managedResources.desc')}
      hideTitle={embedded}
      title={t('managedResources.title')}
      banner={
        conflict ? (
          <Alert
            showIcon
            description={t('managedResources.conflict.desc')}
            message={t('managedResources.conflict.title')}
            type="warning"
            extra={
              <Flexbox horizontal gap={8} wrap="wrap">
                <Button type="default" onClick={handleKeepLocal}>
                  {t('managedResources.conflict.keepLocal')}
                </Button>
                <Button type="default" onClick={() => void handleRebase()}>
                  {t('managedResources.conflict.rebase')}
                </Button>
                <Button type="primary" onClick={() => void handleRefresh()}>
                  {t('managedResources.conflict.discard')}
                </Button>
              </Flexbox>
            }
          />
        ) : null
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
