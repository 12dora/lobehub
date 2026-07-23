'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockerFunction } from 'react-router';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminSettingsService } from '@/enterprise/client/services/adminSettings';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import { openReasonModal } from '../../users/modals/openReasonModal';
import {
  canMutateAgainstBase,
  initialConflictState,
  reduceConflict,
} from '../conflictStateMachine';
import { clearLocalDraft, loadLocalDraft, saveLocalDraft } from '../localDraftStorage';
import type { DraftMap, DraftPolicy, SaveState } from '../settingsPolicyController';
import {
  buildChangePreview,
  clearConflictDraft,
  deriveSettingsPermissions,
  fingerprintDraft,
  isServiceModelManaged,
  loadConflictDraft,
  normalizeSettingsPolicyDraft,
  resolvePrimaryAction,
  saveConflictDraft,
  SERVICE_MODEL_MANAGED_PATHS,
} from '../settingsPolicyController';
import { refreshAdminSettingsDraft, useFetchAdminSettingsDraft } from './useAdminSettings';

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
  // Change preview iterates every registry path with per-path JSON.stringify comparison;
  // memoize so unrelated re-renders (search typing, save-state ticks) don't recompute it.
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
    revisionConflict,
    saveState,
    validatedForFingerprint: validatedFingerprint,
  });

  // Prompt on exit only when the draft actually diverges from the published policy.
  // The settings editor restores a durable localStorage draft as `dirty` on entry, and an
  // edit reverted to its published value stays `dirty` too — so guarding on the raw flag
  // nags even when nothing changed. `preview` is the effective change set (mode/visibility/
  // value vs published), so an empty preview means "nothing to save".
  const hasUnsavedChanges = dirty && preview.length > 0;

  // Only guard real page exits — a same-path `?tab=` switch inside the unified page must not prompt.
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

  // Published paths owned by the Service Model admin page (hidden here) that live in the
  // SAME shared platform settings table. "Restore defaults" must keep these — publishing an
  // empty draft would delete every row and silently wipe model/service/image assignments.
  const isServiceModelPublishedPath = useCallback(
    (path: string) => {
      const entry = registryByPath.get(path);
      return entry ? isServiceModelManaged(entry) : SERVICE_MODEL_MANAGED_PATHS.has(path);
    },
    [registryByPath],
  );

  // Overrides owned by THIS page — drives the Restore-defaults enable-gate so the button is
  // disabled when the only published rows belong to the Service Model page.
  const ownPublishedOverrideCount = useMemo(
    () =>
      Object.keys(data?.publishedPolicies ?? {}).filter(
        (path) => !isServiceModelPublishedPath(path),
      ).length,
    [data?.publishedPolicies, isServiceModelPublishedPath],
  );

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
      resetValidation();
    },
    [canUpdate, getPolicy, resetValidation],
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
    resetValidation();
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
  }, [activeBaseRevision, activeDraftToken, data, draft, mutate, resetValidation]);

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
    resetValidation();
    originalBaseDraftRef.current = next.serverDraft;
    saveLocalDraft({
      baseRevision: next.serverBaseRevision,
      draft: next.localDraft,
      draftToken: next.serverDraftToken ?? '',
      originalBaseDraft: next.serverDraft,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    });
  }, [activeBaseRevision, conflictState, data, resetValidation]);

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
    resetValidation();
    originalBaseDraftRef.current = next.serverDraft;
  }, [activeBaseRevision, conflictState, data, resetValidation]);

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
      resetValidation();
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
    resetValidation,
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
        resetValidation();
        setValidationMsg(
          t('settingsPolicy.validateFail', {
            count: result.issues.length,
            first: result.issues[0]?.message ?? '',
          }),
        );
      }
    } catch (err) {
      resetValidation();
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
    resetValidation,
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

  // "Restore defaults": clear the overrides THIS page owns and publish. Effective settings
  // fall back to their built-in defaults and users regain control. Reuses saveDraft + publish
  // (no dedicated procedure); reauth wraps only the publish retry with a frozen CAS token,
  // mirroring the managed-resources save flow.
  //
  // The reset draft KEEPS service-model-managed published paths (owned by the Service Model
  // admin page, hidden here) — they share the same platform settings table, and publishing an
  // empty draft would run an unscoped delete and wipe those model/service/image assignments.
  const handleResetDefaults = useCallback(() => {
    if (
      !data ||
      !canPublish ||
      !canUpdate ||
      dirty ||
      revisionConflict ||
      activeBaseRevision !== data.baseRevision ||
      activeDraftToken !== data.draftToken ||
      ownPublishedOverrideCount === 0
    ) {
      return;
    }
    const registryVersion = data.registryVersion;
    const baseToken = activeDraftToken;
    const baseRevision = activeBaseRevision;
    // Current (clean) draft — restored if saveDraft commits but publish fails.
    const priorDraft = draft;
    // Keep only paths owned by another surface; dropping this page's paths restores their defaults.
    const resetDraft = Object.fromEntries(
      Object.entries(data.publishedPolicies).filter(([path]) => isServiceModelPublishedPath(path)),
    ) as DraftMap;
    openDangerConfirm({
      confirmText: t('settingsPolicy.resetDefaults'),
      content: t('settingsPolicy.resetDefaultsDesc'),
      onConfirm: async () => {
        const reason = t('settingsPolicy.resetReason');
        let saved: Awaited<ReturnType<typeof adminSettingsService.saveDraft>> | null = null;
        try {
          saved = await adminSettingsService.saveDraft({
            draft: resetDraft,
            expectedDraftToken: baseToken,
            reason,
          });
          const frozen = Object.freeze({
            expectedDraftToken: saved.draftToken,
            expectedRevision: saved.baseRevision,
            reason,
          });
          await withAdminReauthRetry(() => adminSettingsService.publish({ ...frozen }), {
            authMethod: authMethod ?? null,
          });
          // Published — do not attempt a restore in the catch below.
          saved = null;
          clearLocalDraft(registryVersion, baseRevision);
          clearConflictDraft();
          setDraft({});
          setDirty(false);
          setSaveState('idle');
          setSaveError(null);
          setValidationMsg(null);
          setImpact(null);
          resetValidation();
          hydratedRef.current = false;
          await mutate();
          await refreshAdminSettingsDraft();
        } catch (err) {
          // saveDraft committed an empty draft but publish never landed — put the prior
          // draft back so the server draft is not left cleared. Best-effort only.
          if (saved) {
            try {
              await adminSettingsService.saveDraft({
                draft: priorDraft,
                expectedDraftToken: saved.draftToken,
                reason: `${reason} (restore)`,
              });
            } catch {
              /* best-effort restore */
            }
          }
          const mapped = mapEnterpriseError(err);
          if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
            await enterRevisionConflict();
            return;
          }
          setSaveState('failed');
          setSaveError(
            mapped ? t(mapped.i18nKey as never, { defaultValue: mapped.code }) : String(err),
          );
          toast.error(t('settingsPolicy.resetFailed'));
        }
      },
      title: t('settingsPolicy.resetDefaults'),
    });
  }, [
    activeBaseRevision,
    activeDraftToken,
    authMethod,
    canPublish,
    canUpdate,
    data,
    dirty,
    draft,
    enterRevisionConflict,
    isServiceModelPublishedPath,
    mutate,
    ownPublishedOverrideCount,
    resetValidation,
    revisionConflict,
    t,
  ]);

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
    registryByPath,
    revisionConflict,
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
