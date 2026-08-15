'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockerFunction } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import { pruneLegacyAdminSettingsDrafts } from '../pruneLegacySettingsDrafts';
import type { DraftMap, DraftPolicy, SaveState } from '../settingsPolicyController';
import {
  buildChangePreview,
  deriveSettingsPermissions,
  isServiceModelManaged,
  SERVICE_MODEL_MANAGED_PATHS,
} from '../settingsPolicyController';
import { useFetchAdminSettingsDraft } from './useAdminSettings';
import type { SettingsPolicyConflictState } from './useSettingsPolicyPersistence';
import { useSettingsPolicyPersistence } from './useSettingsPolicyPersistence';

export type SettingsPolicyRegistryEntry = AdminSettingsGetDraftOutput['registry'][number];

export const useSettingsPolicyEditor = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const { t } = useTranslation('admin');
  const platform = useEnterprisePlatform();
  const policyEnabled = platform.capabilities.userSettingsPolicyEnabled === true;
  const { authMethod, permissions } = useAdminAccess();
  const { canUpdate, canPublish } = deriveSettingsPermissions(permissions);
  // Saving applies site-wide in one step, so editing requires both write permissions.
  const canSave = canUpdate && canPublish;

  const { data, error, isLoading, mutate } = useFetchAdminSettingsDraft(policyEnabled);

  const [draft, setDraft] = useState<DraftMap>({});
  const [search, setSearch] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<SettingsPolicyConflictState>('none');
  const [dirty, setDirty] = useState(false);
  const [activeBaseRevision, setActiveBaseRevision] = useState(0);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const observedServerSnapshotRef = useRef<string | null>(null);

  // Drafts are never persisted locally any more — drop what older builds left behind.
  useEffect(() => {
    pruneLegacyAdminSettingsDrafts();
  }, []);

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

  /**
   * The editor diverges from the published policy (preview is the effective change set).
   * This — not the sticky `dirty` flag — decides whether 保存 does anything: a legacy
   * stranded draft arrives unedited yet appliable, and reverting an edit leaves nothing to save.
   */
  const hasEffectiveChanges = preview.length > 0;
  // Only guard the exit for edits the admin made in this session.
  const hasUnsavedChanges = dirty && hasEffectiveChanges;
  const shouldBlockPageExit = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => {
      if (!hasUnsavedChanges) return false;
      if (currentLocation.pathname !== nextLocation.pathname) return true;
      return embedded && currentLocation.search !== nextLocation.search;
    },
    [embedded, hasUnsavedChanges],
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

  /**
   * Hydrate from the server snapshot. While the admin has unsaved edits we keep them and
   * skip the incoming snapshot: the server CAS rejects a stale base on save, and that path
   * reloads with an explicit "someone else saved" notice instead of silently overwriting.
   */
  useEffect(() => {
    if (!data || dirty) return;
    const snapshotIdentity = `${data.registryVersion}:${data.baseRevision}:${data.draftToken}`;
    if (observedServerSnapshotRef.current === snapshotIdentity) return;
    observedServerSnapshotRef.current = snapshotIdentity;
    setActiveBaseRevision(data.baseRevision);
    setActiveDraftToken(data.draftToken);
    setDraft(data.draft ?? {});
    setSaveState('idle');
    setSaveError(null);
  }, [data, dirty]);

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
      if (!canSave) return;
      setDraft((prev) => {
        const base = prev[path] ?? getPolicy(path);
        return { ...prev, [path]: { ...base, ...patch } };
      });
      setDirty(true);
      setSaveState('idle');
      setSaveError(null);
      setConflictState('none');
    },
    [canSave, getPolicy],
  );

  const { handleResetDefaults, handleSave, retryConflictReload, retryRefresh } =
    useSettingsPolicyPersistence({
      authMethod,
      canSave,
      editor: {
        activeBaseRevision,
        activeDraftToken,
        data,
        draft,
        hasEffectiveChanges,
        isServiceModelPublishedPath,
        observedServerSnapshotRef,
        saveState,
        setActiveBaseRevision,
        setActiveDraftToken,
        setDirty,
        setDraft,
      },
      feedback: { setConflictState, setRefreshError, setSaveError, setSaveState },
      mutate,
      ownPublishedOverrideCount,
    });

  return {
    canSave,
    conflictState,
    data,
    dismissConflict: useCallback(() => setConflictState('none'), []),
    error,
    filteredEntries,
    getPolicy,
    handleResetDefaults,
    handleSave,
    hasEffectiveChanges,
    isLoading,
    mutate,
    ownPublishedOverrideCount,
    policyEnabled,
    preview,
    refreshError,
    registryByPath,
    retryConflictReload,
    retryRefresh,
    saveError,
    saveState,
    search,
    setSearch,
    updatePolicy,
  };
};
