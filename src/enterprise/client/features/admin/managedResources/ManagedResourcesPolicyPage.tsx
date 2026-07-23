'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, confirmModal, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminManagedResourcesService } from '@/enterprise/client/services/adminManagedResources';
import type { AdminManagedResourcesGetOutput } from '@/server/enterprise/contracts/adminManagedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { publishManagedResourcePolicy, saveManagedResourceDraft } from './actions';
import {
  deriveManagedResourcePermissions,
  fromManagedResourceUiMode,
  getUnreadyEnforcedResources,
  MANAGED_RESOURCE_NAV_LABEL_KEY,
  type ManagedResourceSaveState,
  type ManagedResourceUiMode,
  normalizeManagedResourcePolicyMap,
  toManagedResourceUiMode,
} from './controller';
import { useFetchAdminManagedResources } from './hooks/useAdminManagedResources';
import SharedOAuthAuthorizationControl from './SharedOAuthAuthorizationControl';
import SidebarLayoutControl from './SidebarLayoutControl';
import { createUnsavedNavigationDecision } from './unsavedNavigationDecision';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  `,
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

    /* Cards stay readable; do not force all boxes into one cramped row. */
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
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
  const { data, error, isLoading, mutate } = useFetchAdminManagedResources(canView);

  const [draft, setDraft] = useState<ManagedResourcePolicyMap | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<ManagedResourceSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [activeBaseRevision, setActiveBaseRevision] = useState(0);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const hydratedRef = useRef(false);
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  // Direct-save UX: editing applies immediately; there is no local draft cache, so entering
  // the tab is never spuriously "dirty" and leaving only prompts when there are real edits.
  // Only guard real page exits — a same-path `?tab=` switch inside the unified page must not prompt.
  const blocker = useBlocker(
    useCallback(
      ({
        currentLocation,
        nextLocation,
      }: {
        currentLocation: { pathname: string };
        nextLocation: { pathname: string };
      }) => dirty && currentLocation.pathname !== nextLocation.pathname,
      [dirty],
    ),
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      leaveModalRef.current?.close();
      leaveModalRef.current = null;
      return;
    }
    if (leaveModalRef.current) return;

    const decision = createUnsavedNavigationDecision({
      onCancel: () => {
        leaveModalRef.current = null;
        blocker.reset?.();
      },
      onProceed: () => {
        leaveModalRef.current = null;
        blocker.proceed?.();
      },
    });
    leaveModalRef.current = confirmModal({
      cancelText: t('managedResources.unsavedStay'),
      content: t('managedResources.unsavedLeave'),
      okText: t('managedResources.unsavedConfirm'),
      onCancel: decision.cancel,
      onOk: decision.proceed,
      title: t('managedResources.unsavedTitle'),
    });
  }, [blocker.proceed, blocker.reset, blocker.state, t]);

  useEffect(
    () => () => {
      leaveModalRef.current?.destroy();
      leaveModalRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    setDraft(data.draft);
    setActiveBaseRevision(data.baseRevision);
    setActiveDraftToken(data.draftToken);
    setDirty(false);
    setSaveState('idle');
    setConflict(false);
  }, [data]);

  const updateUiMode = useCallback(
    (resource: ManagedResourceKind, mode: ManagedResourceUiMode) => {
      if (!canUpdate || conflict) return;
      const next = fromManagedResourceUiMode(mode);
      setDraft((current) => (current ? { ...current, [resource]: next } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [canUpdate, conflict],
  );

  const unready = useMemo(
    () =>
      data && draft
        ? // Evaluate readiness against the canonical platform-managed form so historical
          // true+ui-only (shown as platform) still requires catalog readiness before save.
          getUnreadyEnforcedResources(normalizeManagedResourcePolicyMap(draft), data.readiness)
        : [],
    [data, draft],
  );

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
      setDraft(latest.draft);
      setActiveBaseRevision(latest.baseRevision);
      setActiveDraftToken(latest.draftToken);
      setDirty(false);
      setSaveState('idle');
      setConflict(false);
    } catch {
      setActionError(t('managedResources.errors.refresh'));
    }
  }, [mutate, t]);

  // Direct save: persist the draft and publish it in one action (reason is auto-supplied).
  const handleSave = useCallback(async () => {
    if (!data || !draft || !canUpdate || !canPublish || conflict || unready.length > 0) return;
    const reason = t('managedResources.saveReason');
    // Collapse legacy true+ui-only / true+observe combinations into the two canonical pairs.
    const normalizedDraft = normalizeManagedResourcePolicyMap(draft);
    setSaveState('saving');
    setActionError(null);
    try {
      const saved = await saveManagedResourceDraft({
        input: { draft: normalizedDraft, expectedDraftToken: activeDraftToken, reason },
        saveDraft: adminManagedResourcesService.saveDraft,
      });
      setDraft(normalizedDraft);
      // Persist the advanced CAS token/revision immediately: if the publish step below fails
      // (e.g. cancelled reauth, catalog-not-ready), a Save retry must use the just-saved token,
      // not the stale pre-save one — otherwise it would raise a spurious revision conflict.
      setActiveBaseRevision(saved.baseRevision);
      setActiveDraftToken(saved.draftToken);
      await publishManagedResourcePolicy({
        authMethod: authMethod ?? null,
        input: {
          expectedDraftToken: saved.draftToken,
          expectedRevision: saved.baseRevision,
          reason,
        },
        publish: adminManagedResourcesService.publish,
        refreshCapabilities: platform.refresh,
      });
      setDirty(false);
      setSaveState('saved');
      hydratedRef.current = false;
      await mutate();
    } catch (cause) {
      const mapped = mapEnterpriseError(cause);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        enterConflict();
        return;
      }
      setSaveState('failed');
      setActionError(
        mapped
          ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
          : t('managedResources.errors.generic'),
      );
    }
  }, [
    activeDraftToken,
    authMethod,
    canPublish,
    canUpdate,
    conflict,
    data,
    draft,
    enterConflict,
    mutate,
    platform,
    t,
    unready.length,
  ]);

  const renderLoaded = (snapshot: AdminManagedResourcesGetOutput) => {
    if (!draft) return <Loading debugId="AdminManagedResources > Hydrate" />;

    const canSave = canUpdate && canPublish;

    return (
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
                <Button type="primary" onClick={() => void handleRefresh()}>
                  {t('managedResources.conflict.discard')}
                </Button>
              }
            />
          ) : null
        }
      >
        {!canSave ? <Alert showIcon message={t('managedResources.readOnly')} type="info" /> : null}

        <div className={styles.grid}>
          {MANAGED_RESOURCE_KINDS.map((resource) => {
            const item = draft[resource];
            const uiMode = toManagedResourceUiMode(item);
            return (
              <section className={styles.card} key={resource}>
                <div className={styles.row}>
                  <Text strong>{t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never)}</Text>
                  <Select
                    aria-label={`${t(MANAGED_RESOURCE_NAV_LABEL_KEY[resource] as never)} ${t('managedResources.uiMode.label')}`}
                    disabled={!canSave || conflict}
                    // Unified policy-mode select width — keep in sync with the sidebar + settings boxes.
                    style={{ width: 160 }}
                    value={uiMode}
                    options={UI_MODE_VALUES.map((mode) => ({
                      label: t(`managedResources.uiMode.${mode}` as never),
                      value: mode,
                    }))}
                    onChange={(mode) => updateUiMode(resource, mode as ManagedResourceUiMode)}
                  />
                </div>
                {resource === 'connectors' ? (
                  <SharedOAuthAuthorizationControl disabled={!canSave || conflict} />
                ) : null}
              </section>
            );
          })}

          <SidebarLayoutControl disabled={!canSave || conflict} />
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
            </span>
            {actionError ? <Text type="danger">{actionError}</Text> : null}
          </Flexbox>
          {canSave ? (
            <Button
              disabled={!dirty || conflict || unready.length > 0}
              loading={saveState === 'saving'}
              type="primary"
              onClick={() => void handleSave()}
            >
              {t('managedResources.actions.save')}
            </Button>
          ) : null}
        </div>
      </AdminPageTemplate>
    );
  };

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminManagedResources" />}
      onRetry={() => void mutate()}
    >
      {data ? renderLoaded(data) : null}
    </AsyncBoundary>
  );
});

ManagedResourcesPolicyPage.displayName = 'ManagedResourcesPolicyPage';

export default ManagedResourcesPolicyPage;
