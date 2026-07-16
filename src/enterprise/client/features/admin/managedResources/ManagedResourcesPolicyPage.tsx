'use client';

import { Alert, Flexbox, Text, TextArea } from '@lobehub/ui';
import { Button, confirmModal, Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import type {
  ManagedResourceEnforcementMode,
  ManagedResourceKind,
} from '@/const/platform/managedResources';
import { MANAGED_RESOURCE_KINDS } from '@/const/platform/managedResources';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminManagedResourcesService } from '@/enterprise/client/services/adminManagedResources';
import type { AdminManagedResourcesGetOutput } from '@/server/enterprise/contracts/adminManagedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import { publishManagedResourcePolicy, saveManagedResourceDraft } from './actions';
import {
  buildManagedResourceDiff,
  deriveManagedResourcePermissions,
  fingerprintManagedResourcePolicy,
  getUnreadyEnforcedResources,
  type ManagedResourceRebaseConflict,
  type ManagedResourceSaveState,
  rebaseManagedResourceDraft,
  resolveManagedResourcePrimaryAction,
} from './controller';
import { useFetchAdminManagedResources } from './hooks/useAdminManagedResources';
import {
  clearManagedResourceLocalDraft,
  loadManagedResourceLocalDraft,
  saveManagedResourceLocalDraft,
} from './localDraftStorage';
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
  cardHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
  `,
  controls: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-end;
    justify-content: space-between;

    padding-block: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  `,
  impact: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillQuaternary};
  `,
  reason: css`
    width: min(560px, 100%);
  `,
  status: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const MODE_VALUES = ['observe', 'ui-only', 'enforced'] as const;

const ManagedResourcesPolicyPage = memo(() => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const platform = useEnterprisePlatform();
  const { canPublish, canUpdate, canView } = deriveManagedResourcePermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminManagedResources(canView);

  const [draft, setDraft] = useState<ManagedResourcePolicyMap | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<ManagedResourceSaveState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [rebaseConflicts, setRebaseConflicts] = useState<ManagedResourceRebaseConflict[]>([]);
  const [activeBaseRevision, setActiveBaseRevision] = useState(0);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const hydratedRef = useRef(false);
  const originalRef = useRef<ManagedResourcePolicyMap | null>(null);
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);

  const blocker = useBlocker(dirty);
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
    const local = loadManagedResourceLocalDraft();
    if (local) {
      originalRef.current = local.original;
      setDraft(local.draft);
      setDirty(true);
      setSaveState('dirty');
      setActiveBaseRevision(local.baseRevision);
      setActiveDraftToken(local.draftToken);
      setConflict(local.baseRevision !== data.baseRevision || local.draftToken !== data.draftToken);
      return;
    }
    originalRef.current = data.draft;
    setDraft(data.draft);
    setActiveBaseRevision(data.baseRevision);
    setActiveDraftToken(data.draftToken);
    setDirty(false);
    setSaveState('idle');
    setConflict(false);
  }, [data]);

  useEffect(() => {
    if (!dirty || !draft || !originalRef.current) return;
    saveManagedResourceLocalDraft({
      baseRevision: activeBaseRevision,
      draft,
      draftToken: activeDraftToken,
      original: originalRef.current,
      savedAt: new Date().toISOString(),
    });
  }, [activeBaseRevision, activeDraftToken, dirty, draft]);

  const updatePolicy = useCallback(
    (
      resource: ManagedResourceKind,
      patch: Partial<ManagedResourcePolicyMap[ManagedResourceKind]>,
    ) => {
      if (!canUpdate || conflict) return;
      setDraft((current) =>
        current ? { ...current, [resource]: { ...current[resource], ...patch } } : current,
      );
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
    },
    [canUpdate, conflict],
  );

  const diff = useMemo(
    () => (data && draft ? buildManagedResourceDiff(data.published, draft) : []),
    [data, draft],
  );
  const unready = useMemo(
    () => (data && draft ? getUnreadyEnforcedResources(draft, data.readiness) : []),
    [data, draft],
  );
  const primary = resolveManagedResourcePrimaryAction({
    canPublish,
    canUpdate,
    conflict,
    dirty,
    hasChanges: diff.length > 0,
    publishReady: unready.length === 0,
    saveState,
  });

  const validateReason = useCallback(() => {
    const valid = reason.trim().length > 0 && reason.trim().length <= 2000;
    setReasonError(!valid);
    return valid;
  }, [reason]);

  const enterConflict = useCallback(() => {
    setConflict(true);
    setSaveState('failed');
    setActionError(t('managedResources.conflict.desc'));
  }, [t]);

  const handleSave = useCallback(async () => {
    if (!data || !draft || !canUpdate || conflict || !validateReason()) return;
    setSaveState('saving');
    setActionError(null);
    try {
      const result = await saveManagedResourceDraft({
        input: {
          draft,
          expectedDraftToken: activeDraftToken,
          reason: reason.trim(),
        },
        saveDraft: adminManagedResourcesService.saveDraft,
      });
      clearManagedResourceLocalDraft();
      originalRef.current = draft;
      setActiveBaseRevision(result.baseRevision);
      setActiveDraftToken(result.draftToken);
      setDirty(false);
      setSaveState('saved');
      setReason('');
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
    canUpdate,
    conflict,
    data,
    draft,
    enterConflict,
    mutate,
    reason,
    t,
    validateReason,
  ]);

  const handlePublish = useCallback(async () => {
    if (
      !data ||
      !draft ||
      !canPublish ||
      dirty ||
      conflict ||
      unready.length > 0 ||
      !validateReason()
    ) {
      return;
    }
    setSaveState('saving');
    setActionError(null);
    try {
      await publishManagedResourcePolicy({
        authMethod: authMethod ?? null,
        input: {
          expectedDraftToken: activeDraftToken,
          expectedRevision: activeBaseRevision,
          reason: reason.trim(),
        },
        publish: adminManagedResourcesService.publish,
        refreshCapabilities: platform.refresh,
      });
      clearManagedResourceLocalDraft();
      setSaveState('saved');
      setReason('');
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
    activeBaseRevision,
    activeDraftToken,
    authMethod,
    canPublish,
    conflict,
    data,
    dirty,
    draft,
    enterConflict,
    mutate,
    platform,
    reason,
    t,
    unready.length,
    validateReason,
  ]);

  const handleRebase = useCallback(async () => {
    if (!draft || !originalRef.current) return;
    setActionError(null);
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_MANAGED_POLICY_UNAVAILABLE');
      const result = rebaseManagedResourceDraft({
        latest: latest.draft,
        local: draft,
        original: originalRef.current,
      });
      originalRef.current = latest.draft;
      setDraft(result.draft);
      setActiveBaseRevision(latest.baseRevision);
      setActiveDraftToken(latest.draftToken);
      setDirty(
        fingerprintManagedResourcePolicy(result.draft) !==
          fingerprintManagedResourcePolicy(latest.draft),
      );
      setRebaseConflicts(result.conflicts);
      setSaveState(result.conflicts.length > 0 ? 'failed' : 'dirty');
      setConflict(result.conflicts.length > 0);
      setActionError(result.conflicts.length > 0 ? t('managedResources.conflict.fields') : null);
    } catch {
      setActionError(t('managedResources.errors.refresh'));
    }
  }, [draft, mutate, t]);

  const resolveRebaseConflicts = useCallback(
    (resolution: 'latest' | 'local') => {
      if (!draft || rebaseConflicts.length === 0) return;
      const next = structuredClone(draft);
      if (resolution === 'latest') {
        for (const item of rebaseConflicts) {
          const resource = next[item.resource];
          if (item.field === 'managed') resource.managed = item.latestValue as boolean;
          else resource.enforcementMode = item.latestValue as ManagedResourceEnforcementMode;
        }
      }
      setDraft(next);
      setDirty(
        originalRef.current
          ? fingerprintManagedResourcePolicy(next) !==
              fingerprintManagedResourcePolicy(originalRef.current)
          : true,
      );
      setRebaseConflicts([]);
      setConflict(false);
      setSaveState('dirty');
      setActionError(null);
    },
    [draft, rebaseConflicts],
  );

  const handleDiscard = useCallback(async () => {
    setActionError(null);
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_MANAGED_POLICY_UNAVAILABLE');
      clearManagedResourceLocalDraft();
      originalRef.current = latest.draft;
      setDraft(latest.draft);
      setActiveBaseRevision(latest.baseRevision);
      setActiveDraftToken(latest.draftToken);
      setDirty(false);
      setSaveState('idle');
      setRebaseConflicts([]);
      setConflict(false);
    } catch {
      setActionError(t('managedResources.errors.refresh'));
    }
  }, [mutate, t]);

  const renderLoaded = (snapshot: AdminManagedResourcesGetOutput) => {
    if (!draft) return <Loading debugId="AdminManagedResources > Hydrate" />;

    return (
      <AdminPageTemplate
        description={t('managedResources.desc')}
        title={t('managedResources.title')}
        banner={
          <>
            <RevisionBanner
              conflict={conflict}
              draftRevision={activeBaseRevision}
              publishedRevision={snapshot.baseRevision}
              status={snapshot.status}
            />
            {conflict ? (
              <Alert
                showIcon
                message={t('managedResources.conflict.title')}
                type="warning"
                description={t(
                  rebaseConflicts.length > 0
                    ? 'managedResources.conflict.fields'
                    : 'managedResources.conflict.desc',
                )}
                extra={
                  <Flexbox horizontal gap={8}>
                    {rebaseConflicts.length > 0 ? (
                      <>
                        <Button type="primary" onClick={() => resolveRebaseConflicts('local')}>
                          {t('managedResources.conflict.keepLocal')}
                        </Button>
                        <Button onClick={() => resolveRebaseConflicts('latest')}>
                          {t('managedResources.conflict.useLatest')}
                        </Button>
                      </>
                    ) : (
                      <Button type="primary" onClick={() => void handleRebase()}>
                        {t('managedResources.conflict.rebase')}
                      </Button>
                    )}
                    <Button onClick={() => void handleDiscard()}>
                      {t('managedResources.conflict.discard')}
                    </Button>
                  </Flexbox>
                }
              />
            ) : null}
          </>
        }
      >
        {!canUpdate ? (
          <Alert showIcon message={t('managedResources.readOnly')} type="info" />
        ) : null}

        <div className={styles.grid}>
          {MANAGED_RESOURCE_KINDS.map((resource) => {
            const item = draft[resource];
            const ready = snapshot.readiness[resource];
            return (
              <section className={styles.card} key={resource}>
                <div className={styles.cardHeader}>
                  <Flexbox gap={4}>
                    <Text strong>{t(`managedResources.resource.${resource}` as never)}</Text>
                    <Text type="secondary">
                      {t(`managedResources.resource.${resource}.desc` as never)}
                    </Text>
                  </Flexbox>
                  <Text type={ready ? 'success' : 'warning'}>
                    {ready
                      ? t('managedResources.readiness.ready')
                      : t('managedResources.readiness.notReady')}
                  </Text>
                </div>
                <div className={styles.controls}>
                  <Switch
                    checked={item.managed}
                    disabled={!canUpdate || conflict}
                    onChange={(managed) => updatePolicy(resource, { managed })}
                  />
                  <Text>{t('managedResources.managed')}</Text>
                  <Select
                    disabled={!canUpdate || conflict}
                    value={item.enforcementMode}
                    options={MODE_VALUES.map((mode) => ({
                      label: t(`managedResources.mode.${mode}` as never),
                      value: mode,
                    }))}
                    onChange={(mode) =>
                      updatePolicy(resource, {
                        enforcementMode: mode as ManagedResourceEnforcementMode,
                      })
                    }
                  />
                </div>
              </section>
            );
          })}
        </div>

        <Flexbox gap={8}>
          <Text strong>{t('managedResources.impact.title')}</Text>
          {diff.length === 0 ? (
            <Alert message={t('managedResources.impact.empty')} type="info" />
          ) : (
            diff.map((row) => (
              <div className={styles.impact} key={row.resource}>
                <Text strong>{t(`managedResources.resource.${row.resource}` as never)}</Text>
                <Text type="secondary">
                  {t('managedResources.impact.change', {
                    afterManaged: t(`managedResources.boolean.${row.after.managed}` as never),
                    afterMode: t(`managedResources.mode.${row.after.enforcementMode}` as never),
                    beforeManaged: t(`managedResources.boolean.${row.before.managed}` as never),
                    beforeMode: t(`managedResources.mode.${row.before.enforcementMode}` as never),
                  })}
                </Text>
              </div>
            ))
          )}
          {unready.length > 0 ? (
            <Alert
              showIcon
              type="warning"
              message={t('managedResources.readiness.blocked', {
                resources: unready
                  .map((resource) => t(`managedResources.resource.${resource}` as never))
                  .join(', '),
              })}
            />
          ) : null}
        </Flexbox>

        <div className={styles.footer}>
          <Flexbox className={styles.reason} gap={4}>
            <Text strong>{t('managedResources.reason.label')}</Text>
            <TextArea
              maxLength={2000}
              placeholder={t('managedResources.reason.placeholder')}
              rows={2}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(false);
              }}
            />
            {reasonError ? (
              <Text type="danger">{t('managedResources.reason.required')}</Text>
            ) : null}
            <span className={styles.status}>
              {t(`managedResources.saveState.${saveState}` as never)}
            </span>
            {actionError ? <Text type="danger">{actionError}</Text> : null}
          </Flexbox>
          {primary === 'save' || primary === 'retry' ? (
            <Button
              loading={saveState === 'saving'}
              type="primary"
              onClick={() => void handleSave()}
            >
              {primary === 'retry'
                ? t('managedResources.actions.retrySave')
                : t('managedResources.actions.save')}
            </Button>
          ) : primary === 'publish' ? (
            <Button
              loading={saveState === 'saving'}
              type="primary"
              onClick={() => void handlePublish()}
            >
              {t('managedResources.actions.publish')}
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
