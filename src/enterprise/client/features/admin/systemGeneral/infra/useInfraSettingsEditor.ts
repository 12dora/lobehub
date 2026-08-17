'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminSystemTestDependencyResult } from '@/enterprise/client/services/adminSystem';
import type { AdminSystemUpdateInfraSettingsInput } from '@/server/enterprise/contracts/adminSystem';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import {
  INFRA_BLOCKING_ERROR_KEYS,
  type InfraFieldErrors,
  type InfraSettingsDisableConfig,
} from './draft';
import { decideInfraHydration } from './infraSettingsHydration';
import { invalidateAdminInfraSettings } from './invalidate';
import { resolveInfraSaveError } from './serverErrors';
import { type InfraSettingsMutationService, infraSettingsMutationService } from './service';
import type { InfraSettingsConfigInput, InfraSettingsSource } from './types';

export interface UseInfraSettingsEditorParams<TDraft> {
  /** SYSTEM_OPERATE — without it the card stays a read-only view. */
  canOperate: boolean;
  dependency: 'mail' | 'objectStorage';
  fingerprint: (draft: TDraft) => string;
  /**
   * Show validation messages before the first submit. Used for the fail-open recovery state, where
   * the admin has to be told up front which fields must be filled in again.
   */
  revealErrors?: boolean;
  /** CAS token of the row this card writes. */
  revision: number;
  /** Draft derived from the current server snapshot; re-derived on every render. */
  seed: TDraft;
  /** Injectable for tests. */
  service?: InfraSettingsMutationService;
  /** Drop plaintext secrets and re-derive "stored" after a successful write. */
  settle: (draft: TDraft) => TDraft;
  source: InfraSettingsSource;
  toConfig: (draft: TDraft) => InfraSettingsConfigInput;
  /**
   * Payload for 恢复为环境变量 — only the values that are known and well-formed. Switching the
   * override off must not be gated on the configuration being complete (see `draft.ts`).
   */
  toDisableConfig: (draft: TDraft) => InfraSettingsDisableConfig;
  /** `baseline` is the last saved draft, so the rule "destination moved" can be applied. */
  validate: (draft: TDraft, baseline?: TDraft) => InfraFieldErrors;
}

export interface InfraSettingsEditor<TDraft> {
  baseRevision: number;
  beginEdit: () => void;
  /**
   * A stored secret can no longer be reused (its destination changed) — writing and probing are
   * blocked until it is re-entered, because the server would reject them anyway.
   */
  blocked: boolean;
  cancelEdit: () => void;
  /** CAS mismatch — retrying the same payload cannot succeed, only a reload can. */
  conflict: boolean;
  dirty: boolean;
  draft: TDraft;
  /** True when the editable form should be rendered instead of the read-only rows. */
  editing: boolean;
  /** Field name → resolved message; only populated after a submit attempt or a server rejection. */
  errors: Record<string, string>;
  patch: (next: Partial<TDraft>) => void;
  probe?: AdminSystemTestDependencyResult;
  probing: boolean;
  reload: () => Promise<void>;
  revertToEnv: () => void;
  save: () => Promise<void>;
  saving: boolean;
  /** Server snapshot moved while this draft was dirty. */
  stale: boolean;
  test: () => Promise<void>;
}

/**
 * Editing state machine shared by the 对象存储 and 邮件服务 cards.
 *
 * Three things make this more than a `useState`:
 * - the shared SWR snapshot must never wipe an in-progress draft (`decideInfraHydration`);
 * - the write is CAS'd, so a conflict has to become a reload offer rather than a retry;
 * - secrets are write-only, so the plaintext lives in memory for exactly one request.
 */
export const useInfraSettingsEditor = <TDraft>({
  canOperate,
  dependency,
  fingerprint,
  revealErrors = false,
  revision,
  seed,
  service = infraSettingsMutationService,
  settle,
  source,
  toConfig,
  toDisableConfig,
  validate,
}: UseInfraSettingsEditorParams<TDraft>): InfraSettingsEditor<TDraft> => {
  const { t } = useTranslation('admin');
  const { authMethod } = useAdminAccess();

  const seedFp = fingerprint(seed);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const [draft, setDraft] = useState<TDraft>(seed);
  const [baseRevision, setBaseRevision] = useState(revision);
  const [switchedToDb, setSwitchedToDb] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [stale, setStale] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [serverError, setServerError] = useState<{ field?: string; messageKey: string } | null>(
    null,
  );
  const [probe, setProbe] = useState<AdminSystemTestDependencyResult | undefined>();
  const [probing, setProbing] = useState(false);

  /** Last accepted server snapshot — the revert payload and the destination-change rule read it. */
  const [baselineDraft, setBaselineDraft] = useState<TDraft>(seed);
  const baselineFpRef = useRef<string | null>(null);
  const draftFpRef = useRef<string | null>(null);
  const forceRef = useRef(false);
  const savingRef = useRef(false);

  const draftFp = fingerprint(draft);
  // Keep the hydration effect's view of the draft in sync without re-subscribing per keystroke.
  useEffect(() => {
    draftFpRef.current = draftFp;
  }, [draftFp]);

  const applySnapshot = useCallback(
    (next: TDraft, nextRevision: number) => {
      const fp = fingerprint(next);
      baselineFpRef.current = fp;
      draftFpRef.current = fp;
      setBaselineDraft(next);
      setDraft(next);
      setBaseRevision(nextRevision);
      setConflict(false);
      setStale(false);
      setShowErrors(false);
      setServerError(null);
    },
    [fingerprint],
  );

  useEffect(() => {
    const decision = decideInfraHydration({
      baselineFp: baselineFpRef.current,
      draftFp: draftFpRef.current,
      force: forceRef.current,
      nextFp: seedFp,
      saving: savingRef.current,
    });
    forceRef.current = false;
    if (decision.action === 'accept') {
      applySnapshot(seedRef.current, revision);
      return;
    }
    if (decision.markStale) {
      setStale(true);
      return;
    }
    // Same content, newer CAS token (someone re-saved an identical config) — adopt the token so
    // the next save is not rejected against a revision that no longer exists.
    setBaseRevision(revision);
  }, [applySnapshot, revision, seedFp]);

  const dirty = baselineFpRef.current !== null && draftFp !== baselineFpRef.current;

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('systemGeneral.unsaved.stay'),
      content: t('systemGeneral.unsaved.description'),
      okText: t('systemGeneral.unsaved.leave'),
      title: t('systemGeneral.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: dirty, messages: unsavedMessages });

  const patch = useCallback((next: Partial<TDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setServerError(null);
  }, []);

  const validationErrors = useMemo(
    () => validate(draft, baselineDraft),
    [baselineDraft, draft, validate],
  );

  /**
   * A blocking issue is a state the admin has to resolve before anything can be sent, so it is
   * shown immediately instead of waiting for a submit attempt to reveal it.
   */
  const blocked = useMemo(
    () => Object.values(validationErrors).some((key) => INFRA_BLOCKING_ERROR_KEYS.has(key)),
    [validationErrors],
  );

  const errors = useMemo(() => {
    const visible = showErrors || revealErrors;
    const resolved: Record<string, string> = {};
    for (const [field, key] of Object.entries(validationErrors)) {
      if (!visible && !INFRA_BLOCKING_ERROR_KEYS.has(key)) continue;
      resolved[field] = t(`systemGeneral.errors.${key}` as never);
    }
    if (serverError?.field) resolved[serverError.field] = t(serverError.messageKey as never);
    return resolved;
  }, [revealErrors, serverError, showErrors, t, validationErrors]);

  const write = useCallback(
    async (target: TDraft, enabled: boolean) => {
      setSaving(true);
      savingRef.current = true;
      setServerError(null);
      await runAdminMutation({
        authMethod,
        onError: async (cause) => {
          if (cause instanceof AdminReauthCancelledError) {
            toast.error(t('users.errors.reauthCancelled'));
            return;
          }
          if (cause instanceof AdminReauthBlockedError) {
            toast.error(t('users.errors.reauthBlocked'));
            return;
          }
          const resolved = resolveInfraSaveError(cause);
          if (resolved.conflict) {
            setConflict(true);
            toast.error(t('systemGeneral.conflict.title'));
            return;
          }
          setServerError(resolved);
          toast.error(t(resolved.messageKey as never));
        },
        run: async () => {
          // The dependency literal and its config travel together, but a generic draft cannot
          // prove that correlation to the discriminated union — the two card call sites do.
          const result = await service.updateInfraSettings({
            config: enabled ? toConfig(target) : toDisableConfig(target),
            dependency,
            expectedRevision: baseRevision,
          } as AdminSystemUpdateInfraSettingsInput);
          applySnapshot(settle(target), result.revision);
          setSwitchedToDb(false);
          setProbe(undefined);
          toast.success(t(enabled ? 'systemGeneral.edit.saved' : 'systemGeneral.edit.reverted'));
          await invalidateAdminInfraSettings();
        },
      });
      savingRef.current = false;
      setSaving(false);
    },
    [
      applySnapshot,
      authMethod,
      baseRevision,
      dependency,
      service,
      settle,
      t,
      toConfig,
      toDisableConfig,
    ],
  );

  const save = useCallback(async () => {
    if (!canOperate || saving || conflict || stale) return;
    setShowErrors(true);
    if (Object.keys(validationErrors).length > 0) {
      toast.error(t('systemGeneral.edit.invalidDraft'));
      return;
    }
    await write(draft, true);
  }, [canOperate, conflict, draft, saving, stale, t, validationErrors, write]);

  /**
   * Switching the override off is deliberately NOT gated on `validationErrors`: a configuration that
   * cannot be saved (missing credential, fail-open recovery) must still be disable-able.
   */
  const revertToEnv = useCallback(() => {
    if (!canOperate || saving || conflict || stale) return;
    openDangerConfirm({
      confirmText: t('systemGeneral.edit.revertConfirmOk'),
      content: t('systemGeneral.edit.revertConfirm'),
      title: t('systemGeneral.edit.revertTitle'),
      onConfirm: async () => {
        // Write the LAST SAVED configuration back with the override switched off: unsaved edits
        // must not be persisted by an action whose whole point is going back to the environment.
        await write(baselineDraft, false);
      },
    });
  }, [baselineDraft, canOperate, conflict, saving, stale, t, write]);

  const reload = useCallback(async () => {
    forceRef.current = true;
    await invalidateAdminInfraSettings();
  }, []);

  const test = useCallback(async () => {
    if (probing) return;
    setShowErrors(true);
    if (Object.keys(validationErrors).length > 0) {
      toast.error(t('systemGeneral.edit.invalidDraft'));
      return;
    }
    setProbing(true);
    setServerError(null);
    try {
      const result = await service.testDependency({ dependency, draft: toConfig(draft) });
      setProbe(result);
    } catch (cause) {
      // A rejected probe is not always a network problem: the server also refuses to reuse a
      // stored secret against a changed destination. Say which field is at fault when it does.
      const resolved = resolveInfraSaveError(cause);
      if (resolved.field) {
        setServerError(resolved);
        toast.error(t(resolved.messageKey as never));
        setProbe(undefined);
      } else {
        setProbe({ checkedAt: new Date(), latencyMs: 0, message: 'unreachable', ok: false });
      }
    } finally {
      setProbing(false);
    }
  }, [dependency, draft, probing, service, t, toConfig, validationErrors]);

  const beginEdit = useCallback(() => {
    setSwitchedToDb(true);
    applySnapshot(seedRef.current, revision);
  }, [applySnapshot, revision]);

  const cancelEdit = useCallback(() => {
    setSwitchedToDb(false);
    setProbe(undefined);
    applySnapshot(seedRef.current, revision);
  }, [applySnapshot, revision]);

  return {
    baseRevision,
    beginEdit,
    blocked,
    cancelEdit,
    conflict,
    dirty,
    draft,
    editing: canOperate && (source === 'db' || switchedToDb),
    errors,
    patch,
    probe,
    probing,
    reload,
    revertToEnv,
    save,
    saving,
    stale,
    test,
  };
};
