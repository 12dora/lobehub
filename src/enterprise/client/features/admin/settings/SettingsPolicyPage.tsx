'use client';

import { Alert, Flexbox, Input, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import { openReasonModal } from '../users/modals/openReasonModal';
import { canMutateAgainstBase, initialConflictState, reduceConflict } from './conflictStateMachine';
import { refreshAdminSettingsDraft, useFetchAdminSettingsDraft } from './hooks/useAdminSettings';
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from './localDraftStorage';
import { formatPolicySummary, formatSettingValue } from './policyPresentation';
import { PolicyValueEditor } from './PolicyValueEditor';
import {
  buildChangePreview,
  clearConflictDraft,
  deriveSettingsPermissions,
  fingerprintDraft,
  fromSettingsPolicyUiMode,
  loadConflictDraft,
  normalizeSettingsPolicyDraft,
  resolvePrimaryAction,
  saveConflictDraft,
  type SaveState,
  type SettingsPolicyUiMode,
  toSettingsPolicyUiMode,
} from './settingsPolicyController';

type DraftMap = AdminSettingsGetDraftOutput['draft'];
type DraftPolicy = DraftMap[string];

const styles = createStaticStyles(({ css }) => ({
  empty: css`
    padding: 24px;
    color: ${cssVar.colorTextSecondary};
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  fieldHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
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

    margin-block-start: 8px;
    padding-block: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  `,
  path: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  scroll: css`
    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-height: 0;
  `,
  status: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  conflictActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-block-start: 8px;
  `,
  conflictGrid: css`
    display: grid;
    grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr);
    gap: 8px 16px;
    margin-block-start: 8px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  previewRow: css`
    display: grid;
    grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1fr) minmax(220px, 1fr);
    gap: 8px;

    padding-block: 6px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 760px) {
      grid-template-columns: 1fr;
    }
  `,
}));

const UI_MODE_VALUES = ['user', 'platform'] as const satisfies readonly SettingsPolicyUiMode[];

// The admin "Service model" page (/admin/ai/service-model) already owns model/service
// assignments. These groups/paths are hidden here to avoid a duplicate editing surface
// that could publish conflicting policy. Everything else in each group stays editable.
const SERVICE_MODEL_MANAGED_GROUPS = new Set(['image', 'systemAgent']);
const SERVICE_MODEL_MANAGED_PATHS = new Set([
  'defaultAgent.config.model',
  'defaultAgent.config.provider',
  'tts.openAI.ttsModel',
]);
const isServiceModelManaged = (entry: { group: string; path: string }): boolean =>
  SERVICE_MODEL_MANAGED_GROUPS.has(entry.group) || SERVICE_MODEL_MANAGED_PATHS.has(entry.path);

const GROUPS = ['general', 'memory', 'tool', 'tts', 'notification', 'defaultAgent'] as const;

const SettingsPolicyPage = memo<{ embedded?: boolean }>(({ embedded }) => {
  const { t } = useTranslation('admin');
  const platform = useEnterprisePlatform();
  const policyEnabled = platform.capabilities.userSettingsPolicyEnabled === true;
  const { permissions } = useAdminAccess();
  const { canUpdate, canPublish } = deriveSettingsPermissions(permissions);

  const { data, error, isLoading, mutate } = useFetchAdminSettingsDraft(policyEnabled);

  const [draft, setDraft] = useState<DraftMap>({});
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [impact, setImpact] = useState<{
    pathsWithOverrides: number;
    totalOverrideRows: number;
  } | null>(null);
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [validatedDraftToken, setValidatedDraftToken] = useState<string | null>(null);
  const [validatedBaseRevision, setValidatedBaseRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeBaseRevision, setActiveBaseRevision] = useState(0);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const [conflictState, dispatchConflict] = useReducer(
    reduceConflict,
    undefined,
    initialConflictState,
  );
  const hydratedRef = useRef(false);
  const originalBaseDraftRef = useRef<DraftMap>({});

  const revisionConflict =
    conflictState.phase === 'awaitingServer' ||
    conflictState.phase === 'latestUnavailable' ||
    conflictState.phase === 'conflict';

  const draftFingerprint = useMemo(() => fingerprintDraft(draft), [draft]);
  const primary = resolvePrimaryAction({
    canPublish,
    canUpdate,
    dirty,
    draftFingerprint,
    revisionConflict,
    saveState,
    validatedForFingerprint: validatedFingerprint,
  });

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
    if (blocker.state !== 'blocked') return;
    const leave = window.confirm(t('settingsPolicy.unsavedLeave'));
    if (leave) blocker.proceed?.();
    else blocker.reset?.();
  }, [blocker, t]);

  // Hydrate editor from server + local durable draft / conflict draft
  useEffect(() => {
    if (!data || hydratedRef.current) return;
    hydratedRef.current = true;
    const conflict = loadConflictDraft();
    if (conflict && conflict.registryVersion === data.registryVersion) {
      originalBaseDraftRef.current = conflict.originalBaseDraft;
      setDraft(conflict.draft);
      setDirty(true);
      setActiveBaseRevision(conflict.previousBaseRevision);
      setActiveDraftToken(conflict.previousDraftToken);
      dispatchConflict({
        localBaseRevision: conflict.previousBaseRevision,
        localDraft: conflict.draft,
        localDraftToken: conflict.previousDraftToken,
        originalBaseDraft: conflict.originalBaseDraft,
        type: 'CONFLICT_DETECTED',
      });
      dispatchConflict({
        serverBaseRevision: data.baseRevision,
        serverDraft: data.draft,
        serverDraftToken: data.draftToken,
        type: 'REFRESH_SERVER_SUCCEEDED',
      });
      return;
    }
    const local = loadLocalDraft(data.registryVersion, data.baseRevision);
    if (local) {
      originalBaseDraftRef.current = local.originalBaseDraft;
      setDraft(local.draft);
      setDirty(true);
      setActiveBaseRevision(local.baseRevision);
      setActiveDraftToken(local.draftToken);
      if (local.draftToken !== data.draftToken) {
        dispatchConflict({
          localBaseRevision: local.baseRevision,
          localDraft: local.draft,
          localDraftToken: local.draftToken,
          originalBaseDraft: local.originalBaseDraft,
          type: 'CONFLICT_DETECTED',
        });
        dispatchConflict({
          serverBaseRevision: data.baseRevision,
          serverDraft: data.draft,
          serverDraftToken: data.draftToken,
          type: 'REFRESH_SERVER_SUCCEEDED',
        });
      } else {
        dispatchConflict({ type: 'CLEAR' });
      }
    } else {
      originalBaseDraftRef.current = data.draft;
      setActiveBaseRevision(data.baseRevision);
      setActiveDraftToken(data.draftToken);
      dispatchConflict({ type: 'CLEAR' });
      setDraft(data.draft ?? {});
      setDirty(false);
    }
  }, [data]);

  // Persist dirty draft locally
  useEffect(() => {
    if (!data || !dirty || revisionConflict) return;
    saveLocalDraft({
      baseRevision: activeBaseRevision,
      draft,
      draftToken: activeDraftToken,
      originalBaseDraft: originalBaseDraftRef.current,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    });
  }, [activeBaseRevision, activeDraftToken, data, dirty, draft, revisionConflict]);

  // Warn before unload when dirty
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const registryByPath = useMemo(() => {
    const map = new Map<string, AdminSettingsGetDraftOutput['registry'][number]>();
    for (const entry of data?.registry ?? []) map.set(entry.path, entry);
    return map;
  }, [data?.registry]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.registry ?? []).filter((entry) => {
      if (isServiceModelManaged(entry)) return false;
      if (!q) return true;
      return (
        entry.path.toLowerCase().includes(q) ||
        entry.titleKey.toLowerCase().includes(q) ||
        entry.group.toLowerCase().includes(q)
      );
    });
  }, [data?.registry, search]);

  const getPolicy = useCallback(
    (path: string): DraftPolicy => {
      if (draft[path]) return draft[path]!;
      const published = data?.publishedPolicies[path];
      if (published) return published;
      const entry = registryByPath.get(path);
      // Seed the editor with the current effective baseline (built-in default) so the form
      // default-loads the current value instead of rendering blank. This is display-only —
      // it is NOT written into `draft`, so it does not mark the form dirty.
      return {
        mode: 'user',
        schemaVersion: entry?.schemaVersion ?? 1,
        value: entry?.builtInDefault,
        visibility: 'visible',
      };
    },
    [data?.publishedPolicies, draft, registryByPath],
  );

  const updatePolicy = useCallback(
    (path: string, patch: Partial<DraftPolicy>) => {
      if (!canUpdate) return;
      setDraft((prev) => {
        const base = prev[path] ?? getPolicy(path);
        return { ...prev, [path]: { ...base, ...patch } };
      });
      setDirty(true);
      setSaveState('idle');
      setSaveError(null);
      setValidationMsg(null);
      setImpact(null);
      setValidatedFingerprint(null);
      setValidatedDraftToken(null);
      setValidatedBaseRevision(null);
    },
    [canUpdate, getPolicy],
  );

  const enterRevisionConflict = useCallback(async () => {
    if (!data) return;
    const payload = {
      draft,
      originalBaseDraft: originalBaseDraftRef.current,
      previousBaseRevision: activeBaseRevision,
      previousDraftToken: activeDraftToken,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    };
    saveConflictDraft(payload);
    setDirty(true);
    setSaveState('failed');
    setValidatedFingerprint(null);
    setValidatedDraftToken(null);
    setValidatedBaseRevision(null);
    dispatchConflict({
      localBaseRevision: activeBaseRevision,
      localDraft: draft,
      localDraftToken: activeDraftToken,
      originalBaseDraft: originalBaseDraftRef.current,
      type: 'CONFLICT_DETECTED',
    });
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_SETTINGS_DRAFT_UNAVAILABLE');
      dispatchConflict({
        serverBaseRevision: latest.baseRevision,
        serverDraft: latest.draft,
        serverDraftToken: latest.draftToken,
        type: 'REFRESH_SERVER_SUCCEEDED',
      });
    } catch {
      dispatchConflict({ type: 'REFRESH_SERVER_FAILED' });
    }
  }, [activeBaseRevision, activeDraftToken, data, draft, mutate]);

  const refreshConflictServer = useCallback(async () => {
    dispatchConflict({ type: 'REFRESH_SERVER_STARTED' });
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_SETTINGS_DRAFT_UNAVAILABLE');
      dispatchConflict({
        serverBaseRevision: latest.baseRevision,
        serverDraft: latest.draft,
        serverDraftToken: latest.draftToken,
        type: 'REFRESH_SERVER_SUCCEEDED',
      });
    } catch {
      dispatchConflict({ type: 'REFRESH_SERVER_FAILED' });
    }
  }, [mutate]);

  const handleRebase = useCallback(() => {
    if (!data || conflictState.phase !== 'conflict') return;
    const next = reduceConflict(conflictState, { type: 'REBASE' });
    dispatchConflict({ type: 'REBASE' });
    clearConflictDraft();
    clearLocalDraft(data.registryVersion, activeBaseRevision);
    setActiveBaseRevision(next.serverBaseRevision);
    setActiveDraftToken(next.serverDraftToken ?? '');
    setDraft(next.localDraft);
    setDirty(true);
    setSaveState('idle');
    setSaveError(null);
    setValidationMsg(null);
    setImpact(null);
    setValidatedFingerprint(null);
    setValidatedDraftToken(null);
    setValidatedBaseRevision(null);
    originalBaseDraftRef.current = next.serverDraft;
    saveLocalDraft({
      baseRevision: next.serverBaseRevision,
      draft: next.localDraft,
      draftToken: next.serverDraftToken ?? '',
      originalBaseDraft: next.serverDraft,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    });
  }, [activeBaseRevision, conflictState, data]);

  const handleDiscardConflict = useCallback(() => {
    if (!data || conflictState.phase !== 'conflict') return;
    const next = reduceConflict(conflictState, { type: 'DISCARD' });
    dispatchConflict({ type: 'DISCARD' });
    clearConflictDraft();
    clearLocalDraft(data.registryVersion, activeBaseRevision);
    clearLocalDraft(data.registryVersion, next.serverBaseRevision);
    setActiveBaseRevision(next.serverBaseRevision);
    setActiveDraftToken(next.serverDraftToken ?? '');
    setDraft(next.serverDraft);
    setDirty(false);
    setSaveState('idle');
    setSaveError(null);
    setValidationMsg(null);
    setImpact(null);
    setValidatedFingerprint(null);
    setValidatedDraftToken(null);
    setValidatedBaseRevision(null);
    originalBaseDraftRef.current = next.serverDraft;
  }, [activeBaseRevision, conflictState, data]);

  const handleSaveDraft = useCallback(async () => {
    if (
      !data ||
      !canUpdate ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      !canMutateAgainstBase(conflictState, activeBaseRevision, activeDraftToken)
    ) {
      if (data && !revisionConflict) await enterRevisionConflict();
      return;
    }
    setSaveState('saving');
    setSaveError(null);
    // Collapse historical default/locked (+ any visibility) into locked+hidden / user+visible.
    const normalizedDraft = normalizeSettingsPolicyDraft(draft);
    try {
      const result = await adminSettingsService.saveDraft({
        draft: normalizedDraft,
        expectedDraftToken: activeDraftToken,
        reason: t('settingsPolicy.saveReason'),
      });
      clearLocalDraft(data.registryVersion, activeBaseRevision);
      clearConflictDraft();
      setDraft(normalizedDraft);
      setDirty(false);
      setSaveState('saved');
      setValidatedFingerprint(null);
      setValidatedDraftToken(null);
      setValidatedBaseRevision(null);
      setActiveBaseRevision(result.baseRevision);
      setActiveDraftToken(result.draftToken);
      originalBaseDraftRef.current = normalizedDraft;
      dispatchConflict({ type: 'CLEAR' });
      hydratedRef.current = false;
      await mutate();
      await refreshAdminSettingsDraft();
    } catch (err) {
      const mapped = mapEnterpriseError(err);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        await enterRevisionConflict();
        return;
      }
      setSaveState('failed');
      setSaveError(
        mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(err),
      );
    }
  }, [
    activeBaseRevision,
    activeDraftToken,
    canUpdate,
    conflictState,
    data,
    draft,
    enterRevisionConflict,
    mutate,
    revisionConflict,
    t,
  ]);

  const handleValidate = useCallback(async () => {
    if (
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data?.baseRevision ||
      activeDraftToken !== data?.draftToken
    ) {
      setValidationMsg(t('settingsPolicy.validateRequiresSaved'));
      return;
    }
    setValidationMsg(null);
    try {
      const result = await adminSettingsService.validateDraft({ draft });
      setImpact(result.impactEstimate);
      if (result.ok) {
        setValidationMsg(t('settingsPolicy.validateOk'));
        setValidatedFingerprint(fingerprintDraft(draft));
        setValidatedDraftToken(activeDraftToken);
        setValidatedBaseRevision(activeBaseRevision);
      } else {
        setValidatedFingerprint(null);
        setValidatedDraftToken(null);
        setValidatedBaseRevision(null);
        setValidationMsg(
          t('settingsPolicy.validateFail', {
            count: result.issues.length,
            first: result.issues[0]?.message ?? '',
          }),
        );
      }
    } catch (err) {
      setValidatedFingerprint(null);
      setValidatedDraftToken(null);
      setValidatedBaseRevision(null);
      const mapped = mapEnterpriseError(err);
      setValidationMsg(mapped ? mapped.code : String(err));
    }
  }, [
    activeBaseRevision,
    activeDraftToken,
    data?.baseRevision,
    data?.draftToken,
    dirty,
    draft,
    revisionConflict,
    t,
  ]);

  const handlePublish = useCallback(() => {
    if (
      !data ||
      !canPublish ||
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      !canMutateAgainstBase(conflictState, activeBaseRevision, activeDraftToken)
    ) {
      if (
        data &&
        !revisionConflict &&
        (activeBaseRevision !== data.baseRevision || activeDraftToken !== data.draftToken)
      ) {
        void enterRevisionConflict();
      }
      return;
    }
    if (
      validatedFingerprint !== fingerprintDraft(draft) ||
      validatedDraftToken !== activeDraftToken ||
      validatedBaseRevision !== activeBaseRevision
    ) {
      setValidationMsg(t('settingsPolicy.publishRequiresValidate'));
      return;
    }
    const confirmationDraftToken = activeDraftToken;
    const confirmationBaseRevision = activeBaseRevision;
    openReasonModal({
      buildPayload: (reason) => ({
        expectedDraftToken: confirmationDraftToken,
        expectedRevision: confirmationBaseRevision,
        reason,
      }),
      description: t('settingsPolicy.publishDesc'),
      impact: impact
        ? t('settingsPolicy.impactSummary', {
            paths: impact.pathsWithOverrides,
            rows: impact.totalOverrideRows,
          })
        : undefined,
      onSubmit: async (payload) => {
        try {
          await adminSettingsService.publish(
            payload as { expectedDraftToken: string; expectedRevision: number; reason: string },
          );
          clearLocalDraft(data.registryVersion, data.baseRevision);
          clearConflictDraft();
          setDirty(false);
          dispatchConflict({ type: 'CLEAR' });
          hydratedRef.current = false;
          await mutate();
        } catch (err) {
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            await enterRevisionConflict();
          }
          throw err;
        }
      },
      submitLabel: t('settingsPolicy.publish'),
      targetLabel: t('settingsPolicy.title'),
      title: t('settingsPolicy.publish'),
    });
  }, [
    activeBaseRevision,
    activeDraftToken,
    canPublish,
    conflictState,
    data,
    dirty,
    draft,
    enterRevisionConflict,
    impact,
    mutate,
    revisionConflict,
    t,
    validatedFingerprint,
    validatedDraftToken,
    validatedBaseRevision,
  ]);

  const handleRollback = useCallback(() => {
    if (
      !data ||
      !canPublish ||
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      data.baseRevision < 1
    ) {
      return;
    }
    openReasonModal({
      buildPayload: (reason) => ({
        expectedDraftToken: activeDraftToken,
        expectedRevision: activeBaseRevision,
        reason,
        targetRevision: Math.max(1, data.baseRevision - 1),
      }),
      danger: true,
      description: t('settingsPolicy.rollbackDesc'),
      onSubmit: async (payload) => {
        try {
          await adminSettingsService.rollback(
            payload as {
              expectedDraftToken: string;
              expectedRevision: number;
              reason: string;
              targetRevision: number;
            },
          );
          clearLocalDraft(data.registryVersion, data.baseRevision);
          setDirty(false);
          hydratedRef.current = false;
          await mutate();
        } catch (err) {
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            await enterRevisionConflict();
          }
          throw err;
        }
      },
      submitLabel: t('settingsPolicy.rollback'),
      targetLabel: t('settingsPolicy.title'),
      title: t('settingsPolicy.rollback'),
    });
  }, [
    activeBaseRevision,
    activeDraftToken,
    canPublish,
    data,
    dirty,
    enterRevisionConflict,
    mutate,
    revisionConflict,
    t,
  ]);

  // U1: policy flag off → disabled surface, zero getDraft
  if (!policyEnabled) {
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        hideTitle={embedded}
        title={t('settingsPolicy.title')}
      >
        <Text type="secondary">{t('settingsPolicy.featureDisabled')}</Text>
      </AdminPageTemplate>
    );
  }

  // Error before empty
  if (error) {
    const mapped = mapEnterpriseError(error);
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        hideTitle={embedded}
        title={t('settingsPolicy.title')}
        actions={
          <Button
            onClick={() => {
              void mutate();
            }}
          >
            {t('primitives.dataTable.retry')}
          </Button>
        }
      >
        <Text className={styles.error}>
          {mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(error)}
        </Text>
      </AdminPageTemplate>
    );
  }

  if (isLoading || !data) {
    return (
      <AdminPageTemplate
        description={t('settingsPolicy.desc')}
        hideTitle={embedded}
        title={t('settingsPolicy.title')}
      >
        <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
      </AdminPageTemplate>
    );
  }

  const preview = buildChangePreview({
    draft,
    published: data.publishedPolicies,
    registryPaths: data.registry.filter((r) => !isServiceModelManaged(r)).map((r) => r.path),
  });

  // Exactly one primary action — sticky footer only (U5)
  const primaryButton =
    primary === 'save' || primary === 'retry' ? (
      <Button
        disabled={!canUpdate}
        loading={saveState === 'saving'}
        type="primary"
        onClick={() => void handleSaveDraft()}
      >
        {primary === 'retry' ? t('settingsPolicy.retrySave') : t('settingsPolicy.saveDraft')}
      </Button>
    ) : primary === 'validate' ? (
      <Button
        disabled={!canUpdate && !canPublish}
        type="primary"
        onClick={() => void handleValidate()}
      >
        {t('settingsPolicy.validate')}
      </Button>
    ) : primary === 'publish' ? (
      <Button
        type="primary"
        disabled={
          !canPublish ||
          validatedDraftToken !== activeDraftToken ||
          validatedBaseRevision !== activeBaseRevision ||
          activeBaseRevision !== data.baseRevision ||
          activeDraftToken !== data.draftToken
        }
        onClick={handlePublish}
      >
        {t('settingsPolicy.publish')}
      </Button>
    ) : null;

  return (
    <AdminPageTemplate
      hideTitle={embedded}
      title={t('settingsPolicy.title')}
      actions={
        <Flexbox horizontal gap={8}>
          {canPublish ? (
            <Button
              disabled={
                data.baseRevision < 1 ||
                dirty ||
                revisionConflict ||
                activeBaseRevision !== data.baseRevision ||
                activeDraftToken !== data.draftToken
              }
              onClick={handleRollback}
            >
              {t('settingsPolicy.rollback')}
            </Button>
          ) : null}
        </Flexbox>
      }
      banner={
        revisionConflict ? (
          <Alert
            showIcon
            closable={false}
            message={t('settingsPolicy.conflict.title')}
            type="warning"
            description={
              <div>
                {conflictState.phase === 'conflict' ? (
                  <>
                    <Text as="div" type="secondary">
                      {t('settingsPolicy.conflict.revisions', {
                        local: conflictState.localBaseRevision,
                        server: conflictState.serverBaseRevision,
                      })}
                    </Text>
                    {conflictState.conflictingPaths.length > 0 ? (
                      <div className={styles.conflictGrid}>
                        {conflictState.conflictingPaths.map((path) => {
                          const entry = registryByPath.get(path);
                          if (!entry) return <Text key={path}>{path}</Text>;
                          return (
                            <div key={path} style={{ gridColumn: '1 / -1' }}>
                              <Text strong>
                                {t(entry.titleKey as never, { defaultValue: path })}
                              </Text>
                              <div className={styles.conflictGrid}>
                                <Text type="secondary">
                                  {t('settingsPolicy.conflict.localValue', {
                                    value: formatSettingValue({
                                      entry,
                                      t,
                                      value: conflictState.localDraft[path]?.value,
                                    }),
                                  })}
                                </Text>
                                <Text type="secondary">
                                  {t('settingsPolicy.conflict.serverValue', {
                                    value: formatSettingValue({
                                      entry,
                                      t,
                                      value: conflictState.serverDraft[path]?.value,
                                    }),
                                  })}
                                </Text>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <Text as="div" type="secondary">
                        {t('settingsPolicy.conflict.noCollisions')}
                      </Text>
                    )}
                    <div className={styles.conflictActions}>
                      <Button onClick={() => void refreshConflictServer()}>
                        {t('settingsPolicy.conflict.refresh')}
                      </Button>
                      {canUpdate ? (
                        <Button type="primary" onClick={handleRebase}>
                          {t('settingsPolicy.conflict.rebase')}
                        </Button>
                      ) : null}
                      <Button onClick={handleDiscardConflict}>
                        {t('settingsPolicy.conflict.discard')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Text as="div" type="secondary">
                      {t(
                        conflictState.phase === 'awaitingServer'
                          ? 'settingsPolicy.conflict.awaitingServer'
                          : 'settingsPolicy.conflict.latestUnavailable',
                      )}
                    </Text>
                    <div className={styles.conflictActions}>
                      <Button
                        disabled={conflictState.phase === 'awaitingServer'}
                        loading={conflictState.phase === 'awaitingServer'}
                        onClick={() => void refreshConflictServer()}
                      >
                        {t('settingsPolicy.conflict.retryRefresh')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            }
          />
        ) : null
      }
      description={
        canUpdate
          ? t('settingsPolicy.desc')
          : `${t('settingsPolicy.desc')} ${t('settingsPolicy.readOnlyHint')}`
      }
      toolbar={
        <Input
          allowClear
          placeholder={t('settingsPolicy.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      }
    >
      <div className={styles.scroll}>
        {validationMsg ? <Text type="secondary">{validationMsg}</Text> : null}
        {impact ? (
          <Text type="secondary">
            {t('settingsPolicy.impactSummary', {
              paths: impact.pathsWithOverrides,
              rows: impact.totalOverrideRows,
            })}
          </Text>
        ) : null}
        {preview.length > 0 ? (
          <div>
            <Text strong>{t('settingsPolicy.changePreview')}</Text>
            {preview.map((row) => {
              const entry = registryByPath.get(row.path);
              return (
                <div className={styles.previewRow} key={row.path}>
                  <Text strong>
                    {entry ? t(entry.titleKey as never, { defaultValue: row.path }) : row.path}
                  </Text>
                  {entry ? (
                    <>
                      <Text type="secondary">
                        {t('settingsPolicy.preview.before', {
                          summary: formatPolicySummary({
                            entry,
                            mode: row.beforeMode,
                            t,
                            value: row.beforeValue,
                            visibility: row.beforeVisibility,
                          }),
                        })}
                      </Text>
                      <Text type="secondary">
                        {t('settingsPolicy.preview.after', {
                          summary: formatPolicySummary({
                            entry,
                            mode: row.afterMode,
                            t,
                            value: row.afterValue,
                            visibility: row.afterVisibility,
                          }),
                        })}
                      </Text>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {GROUPS.map((group) => {
          const entries = filteredEntries.filter((e) => e.group === group);
          if (entries.length === 0) return null;
          return (
            <div className={styles.group} key={group}>
              <Text strong>{t(`settingsPolicy.groups.${group}` as never)}</Text>
              <div className={styles.grid}>
                {entries.map((entry) => {
                  const policy = getPolicy(entry.path);
                  return (
                    <div className={styles.field} id={`setting-${entry.path}`} key={entry.path}>
                      <div className={styles.fieldHeader}>
                        <div>
                          <Text strong>
                            {t(entry.titleKey as never, { defaultValue: entry.path })}
                          </Text>
                          <div className={styles.path}>{entry.path}</div>
                        </div>
                        <div className={styles.row}>
                          <Select
                            aria-label={t('settingsPolicy.uiMode.label')}
                            disabled={!canUpdate}
                            style={{ minWidth: 160 }}
                            value={toSettingsPolicyUiMode(policy)}
                            options={UI_MODE_VALUES.map((value) => ({
                              label: t(`settingsPolicy.uiMode.${value}` as never),
                              value,
                            }))}
                            onChange={(v) =>
                              updatePolicy(entry.path, {
                                ...fromSettingsPolicyUiMode(v as SettingsPolicyUiMode),
                              })
                            }
                          />
                        </div>
                      </div>
                      <Text type="secondary">
                        {t(entry.descriptionKey as never, { defaultValue: '' })}
                      </Text>
                      <PolicyValueEditor
                        control={entry.control}
                        disabled={!canUpdate}
                        label={t(entry.titleKey as never, { defaultValue: entry.path })}
                        max={entry.max}
                        min={entry.min}
                        options={entry.options}
                        step={entry.step}
                        value={policy.value}
                        onChange={(value) => updatePolicy(entry.path, { value })}
                      />
                      {data.publishedPolicies[entry.path] ? (
                        <Text type="secondary">
                          {t('settingsPolicy.publishedValue')}:{' '}
                          {formatSettingValue({
                            entry,
                            t,
                            value: data.publishedPolicies[entry.path]?.value,
                          })}
                        </Text>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {filteredEntries.length === 0 ? (
          <div className={styles.empty}>{t('settingsPolicy.noResults')}</div>
        ) : null}
      </div>

      <div className={styles.footer}>
        <span className={styles.status}>
          {saveState === 'saving' && t('settingsPolicy.saveState.saving')}
          {saveState === 'saved' && t('settingsPolicy.saveState.saved')}
          {saveState === 'failed' && (saveError || t('settingsPolicy.saveState.failed'))}
          {saveState === 'idle' &&
            (dirty ? t('settingsPolicy.saveState.dirty') : t('settingsPolicy.saveState.idle'))}
          {' · '}
          {t('settingsPolicy.revision', { revision: activeBaseRevision })}
        </span>
        <Flexbox horizontal gap={8}>
          {primaryButton}
        </Flexbox>
      </div>
    </AdminPageTemplate>
  );
});

SettingsPolicyPage.displayName = 'SettingsPolicyPage';

export default SettingsPolicyPage;
