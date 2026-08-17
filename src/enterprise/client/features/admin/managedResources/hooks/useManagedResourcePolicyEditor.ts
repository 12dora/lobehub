'use client';

import { toast } from '@lobehub/ui/base-ui';
import debug from 'debug';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockerFunction } from 'react-router';

import type { ManagedResourceKind } from '@/const/platform/managedResources';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { useEnterprisePlatform } from '@/enterprise/client/providers/EnterprisePlatformProvider';
import { adminManagedResourcesService } from '@/enterprise/client/services/adminManagedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import { saveManagedResourcePolicy } from '../actions';
import {
  buildManagedResourceDiff,
  deriveManagedResourcePermissions,
  fromManagedResourceUiMode,
  getUnreadyEnforcedResources,
  type ManagedResourceSaveState,
  type ManagedResourceUiMode,
  normalizeManagedResourcePolicyMap,
  shouldPreserveLocalDraftAfterSave,
} from '../controller';
import { useFetchAdminManagedResources } from './useAdminManagedResources';

const log = debug('lobe-client:admin:managed-resources');

/**
 * Conflict recovery state. `reloaded` is only reachable after the authoritative reload
 * succeeded; `reloadFailed` keeps the local edits and offers a retry.
 */
export type ManagedResourceConflictState = 'none' | 'reloaded' | 'reloadFailed';

const getManagedResourcesSnapshotIdentity = (snapshot: {
  baseRevision: number;
  draftToken: string;
}) => `${snapshot.baseRevision}:${snapshot.draftToken}`;

export const useManagedResourcePolicyEditor = ({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const platform = useEnterprisePlatform();
  const { canPublish, canUpdate, canView } = deriveManagedResourcePermissions(permissions);
  // Saving applies site-wide in one step, so it needs both policy write permissions.
  const canSave = canUpdate && canPublish;
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ManagedResourceConflictState>('none');
  /**
   * The server rejected the last save at its readiness gate. Sticky until the draft changes:
   * the cached readiness map can be stale, so the server verdict has to win on its own.
   */
  const [serverReadinessBlocked, setServerReadinessBlocked] = useState(false);
  const [activeDraftToken, setActiveDraftToken] = useState('');
  const [baseRevision, setBaseRevision] = useState(0);
  const observedServerSnapshotRef = useRef<string | null>(null);
  /**
   * Monotonic local-edit epoch. Bumped on every user draft change; captured at save
   * submit so a successful response never overwrites newer in-flight local edits
   * (even if a race slips past the saving lock before re-render).
   */
  const draftEpochRef = useRef(0);

  const shouldBlockPageExit = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => {
      if (!dirty) return false;
      if (currentLocation.pathname !== nextLocation.pathname) return true;
      return Boolean(embedded) && currentLocation.search !== nextLocation.search;
    },
    [dirty, embedded],
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

  /**
   * Hydrate from the server snapshot. Unsaved local edits win over an incoming snapshot:
   * the server CAS rejects a stale base on save, and that path reloads the live policy with
   * an explicit "someone else saved" notice instead of silently discarding the edits here.
   */
  useEffect(() => {
    if (!data || dirty) return;
    const snapshotIdentity = getManagedResourcesSnapshotIdentity(data);
    if (observedServerSnapshotRef.current === snapshotIdentity) return;
    observedServerSnapshotRef.current = snapshotIdentity;
    setDraft(data.draft);
    setPublished(data.published);
    setActiveDraftToken(data.draftToken);
    setBaseRevision(data.baseRevision);
    setDirty(false);
    setSaveState('idle');
  }, [data, dirty]);

  const editorsLocked = saveState === 'saving';
  const canEditPolicy = canSave && !editorsLocked;

  const updateUiMode = useCallback(
    (resource: ManagedResourceKind, mode: ManagedResourceUiMode) => {
      if (!canSave || editorsLocked) return;
      const next = fromManagedResourceUiMode(mode);
      draftEpochRef.current += 1;
      setDraft((current) => (current ? { ...current, [resource]: next } : current));
      setDirty(true);
      setSaveState('dirty');
      setActionError(null);
      setConflictState('none');
      setServerReadinessBlocked(false);
    },
    [canSave, editorsLocked],
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

  /**
   * Resources the blocked alert names. The refreshed readiness map is preferred; when the
   * server rejected a save the client still believes is ready, fall back to every enforced
   * resource so the alert never contradicts the disabled save button.
   */
  const readinessBlockedResources = useMemo(() => {
    if (unready.length > 0) return unready;
    if (!serverReadinessBlocked || !draft) return [];
    return getUnreadyEnforcedResources(normalizeManagedResourcePolicyMap(draft), {
      agents: false,
      aiModels: false,
      aiProviders: false,
      connectors: false,
      skills: false,
    });
  }, [draft, serverReadinessBlocked, unready]);
  const readinessBlocked = readinessBlockedResources.length > 0;

  const hasChanges = useMemo(() => {
    if (!draft || !published) return false;
    return (
      buildManagedResourceDiff(
        normalizeManagedResourcePolicyMap(published),
        normalizeManagedResourcePolicyMap(draft),
      ).length > 0
    );
  }, [draft, published]);

  /**
   * Someone else saved first — nothing of ours committed. Reload the live policy and only
   * then drop the local edits: on a failed reload the old values are all we have, so keep
   * them (and the conflict banner's retry) instead of claiming the latest ones loaded.
   */
  const reloadAfterStaleBase = useCallback(async () => {
    setActionError(null);
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_MANAGED_POLICY_UNAVAILABLE');
      observedServerSnapshotRef.current = getManagedResourcesSnapshotIdentity(latest);
      draftEpochRef.current += 1;
      setDraft(latest.draft);
      setPublished(latest.published);
      setActiveDraftToken(latest.draftToken);
      setBaseRevision(latest.baseRevision);
      setDirty(false);
      setSaveState('idle');
      setConflictState('reloaded');
    } catch {
      setConflictState('reloadFailed');
      setSaveState('dirty');
    }
  }, [mutate]);

  const mapActionError = useCallback(
    (cause: unknown) => {
      const mapped = mapEnterpriseError(cause);
      setSaveState('failed');
      setActionError(
        mapped
          ? t(mapped.i18nKey as never, { defaultValue: t('managedResources.errors.generic') })
          : t('managedResources.errors.generic'),
      );
    },
    [t],
  );

  /** One primary action: write + publish + invalidate in a single server transaction. */
  const handleSave = useCallback(async () => {
    // No effective change → no site-wide revision, audit row, or cache invalidation.
    if (!data || !draft || !canSave || saveState === 'saving' || !hasChanges || readinessBlocked) {
      return;
    }
    const reason = t('managedResources.saveReason');
    const normalizedDraft = normalizeManagedResourcePolicyMap(draft);
    // Epoch at submit: any later user edit bumps draftEpochRef and must not be clobbered.
    const submittedEpoch = draftEpochRef.current;
    setSaveState('saving');
    setActionError(null);
    setConflictState('none');
    try {
      const { capabilityRefreshFailed, output } = await saveManagedResourcePolicy({
        authMethod: authMethod ?? null,
        input: {
          draft: normalizedDraft,
          expectedDraftToken: activeDraftToken,
          expectedRevision: baseRevision,
          reason,
        },
        // Committed boundary: report the outcome before any best-effort refresh, so the
        // admin is told the policy applied even if a later refresh fails.
        onCommitted: (committed) => {
          if (committed.runtimeTransition === 'pending_recovery') {
            toast.warning(t('managedResources.errors.savedRuntimeRecovering'));
            return;
          }
          toast.success(t('managedResources.saveSuccess'));
        },
        refreshCapabilities: platform.refresh,
        save: adminManagedResourcesService.save,
      });
      setPublished(normalizedDraft);
      if (output.runtimeTransition !== 'pending_recovery' && capabilityRefreshFailed) {
        setActionError(t('managedResources.errors.savedRefreshFailed'));
      }

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

      try {
        const latest = await mutate();
        // Abort applying the refreshed policy if the admin edited while refresh was in flight.
        if (shouldPreserveLocalDraftAfterSave(submittedEpoch, draftEpochRef.current)) {
          setDirty(true);
          setSaveState('dirty');
          setActionError(t('managedResources.errors.savedWithLocalEdits'));
          return;
        }
        if (latest) {
          observedServerSnapshotRef.current = getManagedResourcesSnapshotIdentity(latest);
          setDraft(latest.draft);
          setPublished(latest.published);
          setActiveDraftToken(latest.draftToken);
          setBaseRevision(latest.baseRevision);
        }
      } catch (refreshError) {
        log('post-save refresh failed: %O', refreshError);
        if (!capabilityRefreshFailed) {
          setActionError(t('managedResources.errors.savedRefreshFailed'));
        }
      }
    } catch (cause) {
      const code = mapEnterpriseError(cause)?.code;
      if (code === 'PLATFORM_REVISION_CONFLICT') {
        await reloadAfterStaleBase();
        return;
      }
      // The only validation the managed-resource save performs is its readiness gate, so
      // this means the cached readiness map was stale: reload it and block the save.
      if (code === 'PLATFORM_CONFIG_VALIDATION_FAILED') {
        setServerReadinessBlocked(true);
        setSaveState('failed');
        setActionError(null);
        try {
          await mutate();
        } catch (readinessError) {
          log('readiness refresh after a blocked save failed: %O', readinessError);
        }
        return;
      }
      mapActionError(cause);
    }
  }, [
    activeDraftToken,
    authMethod,
    baseRevision,
    canSave,
    data,
    draft,
    hasChanges,
    mapActionError,
    mutate,
    platform,
    readinessBlocked,
    reloadAfterStaleBase,
    saveState,
    t,
  ]);

  return {
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
  };
};
