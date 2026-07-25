'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockerFunction } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import { initialConflictState, reduceConflict } from '../conflictStateMachine';
import { loadLocalDraft, saveLocalDraft } from '../localDraftStorage';
import type { DraftMap, DraftPolicy, SaveState } from '../settingsPolicyController';
import {
  buildChangePreview,
  deriveSettingsPermissions,
  fingerprintDraft,
  isServiceModelManaged,
  loadConflictDraft,
  resolvePrimaryAction,
  SERVICE_MODEL_MANAGED_PATHS,
} from '../settingsPolicyController';
import type { ResetPartialFailure } from '../settingsPolicyReset';
import { useFetchAdminSettingsDraft } from './useAdminSettings';
import { useSettingsPolicyConflict } from './useSettingsPolicyConflict';
import { useSettingsPolicyPersistence } from './useSettingsPolicyPersistence';

export type SettingsPolicyRegistryEntry = AdminSettingsGetDraftOutput['registry'][number];

export const useSettingsPolicyEditor = () => {
  const { t } = useTranslation('admin');
  const platform = useEnterprisePlatform();
  const policyEnabled = platform.capabilities.userSettingsPolicyEnabled === true;
  const { authMethod, permissions } = useAdminAccess();
  const { canUpdate, canPublish } = deriveSettingsPermissions(permissions);

  const { data, error, isLoading, mutate } = useFetchAdminSettingsDraft(policyEnabled);

  const [draft, setDraft] = useState<DraftMap>({});
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [impact, setImpact] = useState<{
    pathsWithOverrides: number;
    totalOverrideRows: number;
  } | null>(null);
  const [validatedFingerprint, setValidatedFingerprint] = useState<string | null>(null);
  const [validatedDraftToken, setValidatedDraftToken] = useState<string | null>(null);
  const [validatedBaseRevision, setValidatedBaseRevision] = useState<number | null>(null);
  const resetValidation = useCallback(() => {
    setValidatedFingerprint(null);
    setValidatedDraftToken(null);
    setValidatedBaseRevision(null);
  }, []);
  const [dirty, setDirty] = useState(false);
  const [activeBaseRevision, setActiveBaseRevision] = useState(0);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const [resetPartialFailure, setResetPartialFailure] = useState<ResetPartialFailure | null>(null);
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
  /** Partial reset failure locks all mutations until restore or refresh. */
  const mutationLocked = Boolean(resetPartialFailure) || revisionConflict;

  const draftFingerprint = useMemo(() => fingerprintDraft(draft), [draft]);
  const preview = useMemo(
    () =>
      data
        ? buildChangePreview({
            draft,
            published: data.publishedPolicies,
            registryPaths: data.registry
              .filter((r) => !isServiceModelManaged(r))
              .map((r) => r.path),
          })
        : [],
    [draft, data],
  );
  const primary = resolvePrimaryAction({
    canPublish,
    canUpdate,
    dirty,
    draftFingerprint,
    revisionConflict: mutationLocked,
    saveState,
    validatedForFingerprint: validatedFingerprint,
  });

  // Guard when the draft diverges from published policy (preview is the effective change set).
  const hasUnsavedChanges = dirty && preview.length > 0;
  const shouldBlockPageExit = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      hasUnsavedChanges && currentLocation.pathname !== nextLocation.pathname,
    [hasUnsavedChanges],
  );
  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('settingsPolicy.unsavedStay'),
      content: t('settingsPolicy.unsavedLeave'),
      okText: t('settingsPolicy.unsavedConfirm'),
      title: t('settingsPolicy.unsavedTitle'),
    }),
    [t],
  );
  useUnsavedChangesGuard({
    enabled: hasUnsavedChanges,
    messages: unsavedMessages,
    shouldBlock: shouldBlockPageExit,
  });

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

  const registryByPath = useMemo(() => {
    const map = new Map<string, SettingsPolicyRegistryEntry>();
    for (const entry of data?.registry ?? []) map.set(entry.path, entry);
    return map;
  }, [data?.registry]);

  const isServiceModelPublishedPath = useCallback(
    (path: string) => {
      const entry = registryByPath.get(path);
      return entry ? isServiceModelManaged(entry) : SERVICE_MODEL_MANAGED_PATHS.has(path);
    },
    [registryByPath],
  );

  const ownPublishedOverrideCount = useMemo(
    () =>
      Object.keys(data?.publishedPolicies ?? {}).filter(
        (path) => !isServiceModelPublishedPath(path),
      ).length,
    [data?.publishedPolicies, isServiceModelPublishedPath],
  );

  // Search matches machine path/keys AND the localized title/description/group labels
  // users actually see (zh-CN "字体大小" must find titleKey setting.fontSize).
  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.registry ?? []).filter((entry) => {
      if (isServiceModelManaged(entry)) return false;
      if (!q) return true;
      const title = String(t(entry.titleKey as never, { defaultValue: entry.path })).toLowerCase();
      const description = String(
        t(entry.descriptionKey as never, { defaultValue: '' }),
      ).toLowerCase();
      const groupLabel = String(
        t(`settingsPolicy.groups.${entry.group}` as never, { defaultValue: entry.group }),
      ).toLowerCase();
      return (
        entry.path.toLowerCase().includes(q) ||
        entry.titleKey.toLowerCase().includes(q) ||
        entry.group.toLowerCase().includes(q) ||
        title.includes(q) ||
        description.includes(q) ||
        groupLabel.includes(q)
      );
    });
  }, [data?.registry, search, t]);

  const getPolicy = useCallback(
    (path: string): DraftPolicy => {
      if (draft[path]) return draft[path]!;
      const published = data?.publishedPolicies[path];
      if (published) return published;
      const entry = registryByPath.get(path);
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
      if (!canUpdate || resetPartialFailure) return;
      setDraft((prev) => {
        const base = prev[path] ?? getPolicy(path);
        return { ...prev, [path]: { ...base, ...patch } };
      });
      setDirty(true);
      setSaveState('idle');
      setSaveError(null);
      setValidationMsg(null);
      setImpact(null);
      resetValidation();
    },
    [canUpdate, getPolicy, resetPartialFailure, resetValidation],
  );

  const { enterRevisionConflict, handleDiscardConflict, handleRebase, refreshConflictServer } =
    useSettingsPolicyConflict({
      activeBaseRevision,
      activeDraftToken,
      conflictState,
      data,
      dispatchConflict,
      draft,
      mutate,
      originalBaseDraftRef,
      resetValidation,
      setActiveBaseRevision,
      setActiveDraftToken,
      setDirty,
      setDraft,
      setImpact,
      setSaveError,
      setSaveState,
      setValidationMsg,
    });

  const {
    dismissResetPartialByRefresh,
    handlePublish,
    handleResetDefaults,
    handleSaveDraft,
    handleValidate,
    retryRefresh,
    retryResetRestore,
  } = useSettingsPolicyPersistence({
    authMethod,
    canPublish,
    canUpdate,
    cas: {
      activeBaseRevision,
      activeDraftToken,
      conflictState,
      data,
      dispatchConflict,
      enterRevisionConflict,
      revisionConflict,
      setActiveBaseRevision,
      setActiveDraftToken,
    },
    draftEditor: {
      dirty,
      draft,
      hydratedRef,
      isServiceModelPublishedPath,
      originalBaseDraftRef,
      setDirty,
      setDraft,
    },
    feedback: {
      impact,
      resetValidation,
      setImpact,
      setRefreshError,
      setSaveError,
      setSaveState,
      setValidatedBaseRevision,
      setValidatedDraftToken,
      setValidatedFingerprint,
      setValidationMsg,
      validatedBaseRevision,
      validatedDraftToken,
      validatedFingerprint,
    },
    mutate,
    ownPublishedOverrideCount,
    resetPartialFailure,
    setResetPartialFailure,
  });

  return {
    activeBaseRevision,
    activeDraftToken,
    canPublish,
    canUpdate,
    conflictState,
    data,
    dirty,
    error,
    filteredEntries,
    getPolicy,
    handleDiscardConflict,
    handlePublish,
    handleRebase,
    handleResetDefaults,
    handleSaveDraft,
    handleValidate,
    impact,
    isLoading,
    mutate,
    ownPublishedOverrideCount,
    policyEnabled,
    preview,
    primary,
    refreshConflictServer,
    refreshError,
    registryByPath,
    resetPartialFailure,
    retryRefresh,
    retryResetRestore,
    dismissResetPartialByRefresh,
    revisionConflict: mutationLocked,
    saveError,
    saveState,
    search,
    setSearch,
    updatePolicy,
    validatedBaseRevision,
    validatedDraftToken,
    validationMsg,
  };
};
