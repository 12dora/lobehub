'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminDocumentRenderSettingsService,
  AdminSystemDocumentRenderSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import {
  type DocumentRenderDraft,
  fingerprintDocumentRenderDraft,
  toDocumentRenderDraft,
  toDocumentRenderUpdateInput,
  validateDocumentRenderDraft,
} from './documentRenderDraft';
import { decideInfraHydration } from './infraSettingsHydration';
import {
  invalidateAdminDocumentRenderSettings,
  invalidateAdminDocumentRenderStatus,
} from './invalidate';
import { resolveInfraSaveError } from './serverErrors';

export interface UseDocumentRenderSettingsEditorParams {
  canOperate: boolean;
  service?: AdminDocumentRenderSettingsService;
  view: AdminSystemDocumentRenderSettings;
}

/**
 * 文档渲染 take-over editor — the sandbox state machine, plus a connection probe.
 *
 * The probe lives here rather than in the shared `useInfraDependencyProbe` map because that map is
 * keyed by the two environment-owned dependencies; a card that owns its own probe also gets to keep
 * the result next to the endpoint the operator just typed.
 */
export const useDocumentRenderSettingsEditor = ({
  canOperate,
  service = adminSystemService,
  view,
}: UseDocumentRenderSettingsEditorParams) => {
  const { t } = useTranslation('admin');
  const { authMethod } = useAdminAccess();
  const seed = useMemo(() => toDocumentRenderDraft(view), [view]);
  const seedFp = fingerprintDocumentRenderDraft(seed);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  const [draft, setDraft] = useState<DocumentRenderDraft>(seed);
  const [baseRevision, setBaseRevision] = useState(view.revision);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [stale, setStale] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<AdminSystemTestDependencyResult | undefined>(undefined);
  /** Successful writes, so the 编辑 modal closes on 保存 / 恢复 and on nothing else. */
  const [saveCount, setSaveCount] = useState(0);

  const [baselineDraft, setBaselineDraft] = useState<DocumentRenderDraft>(seed);
  const baselineFpRef = useRef<string | null>(null);
  const draftFpRef = useRef<string | null>(null);
  const forceRef = useRef(false);
  const savingRef = useRef(false);

  const draftFp = fingerprintDocumentRenderDraft(draft);
  useEffect(() => {
    draftFpRef.current = draftFp;
  }, [draftFp]);

  const applySnapshot = useCallback((next: DocumentRenderDraft, nextRevision: number) => {
    const fp = fingerprintDocumentRenderDraft(next);
    baselineFpRef.current = fp;
    draftFpRef.current = fp;
    setBaselineDraft(next);
    setDraft(next);
    setBaseRevision(nextRevision);
    setConflict(false);
    setStale(false);
    setShowErrors(false);
  }, []);

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
      applySnapshot(seedRef.current, view.revision);
      return;
    }
    if (decision.markStale) {
      setStale(true);
      return;
    }
    setBaseRevision(view.revision);
  }, [applySnapshot, seedFp, view.revision]);

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

  const patch = useCallback((next: Partial<DocumentRenderDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const validationErrors = useMemo(() => validateDocumentRenderDraft(draft), [draft]);
  const errors = useMemo(() => {
    if (!showErrors) return {};
    const resolved: Record<string, string> = {};
    for (const [field, key] of Object.entries(validationErrors)) {
      resolved[field] = t(`systemGeneral.errors.${key}` as never);
    }
    return resolved;
  }, [showErrors, t, validationErrors]);

  const write = useCallback(
    async (target: DocumentRenderDraft, enabled: boolean) => {
      setSaving(true);
      savingRef.current = true;
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
          toast.error(t(resolved.messageKey as never));
        },
        run: async () => {
          const result = await service.updateDocumentRenderSettings(
            toDocumentRenderUpdateInput(target, enabled, baseRevision),
          );
          applySnapshot(toDocumentRenderDraft(result), result.revision);
          setEditing(false);
          setSaveCount((count) => count + 1);
          toast.success(t(enabled ? 'systemGeneral.edit.saved' : 'systemGeneral.edit.reverted'));
          await invalidateAdminDocumentRenderSettings();
          await invalidateAdminDocumentRenderStatus();
        },
      });
      savingRef.current = false;
      setSaving(false);
    },
    [applySnapshot, authMethod, baseRevision, service, t],
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

  const revertToEnv = useCallback(() => {
    if (!canOperate || saving || conflict || stale) return;
    openDangerConfirm({
      confirmText: t('systemGeneral.edit.revertConfirmOk'),
      content: t('systemGeneral.edit.revertConfirm'),
      title: t('systemGeneral.edit.revertTitle'),
      onConfirm: async () => {
        await write(baselineDraft, false);
      },
    });
  }, [baselineDraft, canOperate, conflict, saving, stale, t, write]);

  const reload = useCallback(async () => {
    forceRef.current = true;
    await invalidateAdminDocumentRenderSettings();
  }, []);

  /**
   * The probe always runs against the SAVED endpoint: the sidecar lives inside the deployment
   * network, so a browser could not reach a draft address anyway, and answering "connected" for an
   * address the server has never seen would be a lie the next save would expose.
   */
  const test = useCallback(async () => {
    if (probing) return;
    setProbing(true);
    try {
      setProbe(await service.testDocumentRender());
    } catch {
      setProbe({ checkedAt: new Date(), latencyMs: 0, message: 'unreachable', ok: false });
    } finally {
      setProbing(false);
    }
  }, [probing, service]);

  return {
    beginEdit: () => setEditing(true),
    cancelEdit: () => {
      setDraft(baselineDraft);
      setEditing(false);
      setShowErrors(false);
      setConflict(false);
    },
    conflict,
    dirty,
    draft,
    editing,
    errors,
    invalid: Object.keys(validationErrors).length > 0 && showErrors,
    patch,
    probe,
    probing,
    reload,
    revertToEnv,
    save,
    saveCount,
    saving,
    stale,
    test,
  };
};
