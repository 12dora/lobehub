'use client';

import { confirmModal, toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
} from '@/enterprise/client/services/adminSystem';

import {
  adoptBrowserProfileSelection,
  type BrowserProfileDraft,
  type BrowserProfileSaveInput,
  browserProfileSelectionKey,
  completeBrowserProfileSelection,
  isBrowserProfileSelectionDirty,
  repairBrowserProfileSelection,
  visibleBrowserProfileOptions,
} from './browserProfileSelection';
import { useInfraEditModal } from './useInfraEditModal';

export interface BrowserProfileEditorOptions {
  canOperate: boolean;
  data?: AdminBrowserProfileSummary;
  onRegenerate: () => Promise<void>;
  onRetry: () => void;
  onSave: (input: BrowserProfileSaveInput) => Promise<void>;
  options?: AdminBrowserProfileOptions;
  t: TFunction<'admin'>;
}

/**
 * The fingerprint card's editing half: which six ids are on screen, whether they still agree with
 * what the platform is running, and the three writes an operator can make.
 *
 * The rules that are easy to lose if this is inlined in the card again:
 *
 * - a same-revision revalidation of the same six ids must leave an edit in progress alone, but a
 *   regeneration re-seeds even when it lands on those same ids (the pools are finite) because the
 *   platform has minted a new installation identity;
 * - a refused save is not a failed one — a revision conflict means the fingerprint moved under this
 *   form, so it offers the reload instead of inviting a retry of the same payload;
 * - every other failure keeps the draft, because the operator's choice is still worth retrying.
 */
export const useBrowserProfileEditor = ({
  canOperate,
  data,
  onRegenerate,
  onRetry,
  onSave,
  options,
  t,
}: BrowserProfileEditorOptions) => {
  const [regenerating, setRegenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [draft, setDraft] = useState<BrowserProfileDraft>();
  /** Accepted writes; the 编辑 modal closes on each one and on nothing else. */
  const [savedCount, setSavedCount] = useState(0);

  // The summary reports the option ids alongside the values they resolved to.
  const storedKey = browserProfileSelectionKey(data);
  /**
   * A same-revision revalidation of the same six ids must leave an edit in progress
   * alone. A regeneration can land on those same ids (the pools are finite) while
   * minting a new revision and a new installation identity — that is a choice the
   * platform made, so it re-seeds too.
   */
  useEffect(() => setDraft(undefined), [data?.installationId, data?.revision, storedKey]);
  // Any revision the card has now caught up with is no longer the one it was refused on.
  useEffect(() => setStale(false), [data?.revision]);

  const settled = useMemo(() => adoptBrowserProfileSelection(options, data), [options, data]);
  const selection = draft ?? settled;
  const complete = useMemo(() => completeBrowserProfileSelection(selection), [selection]);
  const dirty = isBrowserProfileSelectionDirty(data, selection);

  const visible = useMemo(
    () => (options ? visibleBrowserProfileOptions(options, selection?.systemId) : undefined),
    [options, selection?.systemId],
  );

  /** Every change goes back through the settle step: a new machine invalidates its own hardware. */
  const patch = useCallback(
    (next: Partial<BrowserProfileDraft>) =>
      setDraft(repairBrowserProfileSelection(options, { ...selection, ...next })),
    [options, selection],
  );

  const requestRegenerate = useCallback(() => {
    confirmModal({
      // The shared cancel label, not a private copy of the same word.
      cancelText: t('cancel', { ns: 'common' }),
      content: t('browserProfile.confirm.description'),
      okButtonProps: { danger: true },
      okText: t('browserProfile.actions.regenerate'),
      title: t('browserProfile.confirm.title'),
      onOk: async () => {
        setRegenerating(true);
        try {
          await onRegenerate();
          // Even if the new summary reused the previous six ids, this click
          // produced a new fingerprint — drop the operator's unsaved draft.
          setDraft(undefined);
          toast.success(t('browserProfile.toast.regenerated'));
        } catch (cause) {
          toast.error(t('browserProfile.toast.failed'));
          throw cause;
        } finally {
          setRegenerating(false);
        }
      },
    });
  }, [onRegenerate, t]);

  const requestSave = useCallback(async () => {
    if (!complete || !data) return;
    setSaving(true);
    try {
      await onSave({ ...complete, expectedRevision: data.revision });
      setSavedCount((count) => count + 1);
      toast.success(t('browserProfile.toast.saved'));
    } catch (cause) {
      // A refused save is not a failed one. The fingerprint moved under this form, so the six ids
      // on screen would reinstate what the other operator just replaced — say so, and offer the
      // reload, instead of inviting a retry of the same payload.
      if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
        setStale(true);
        toast.error(t('systemGeneral.conflict.title'));
      } else {
        // The draft stays: the operator's choice is still on screen to retry or amend.
        toast.error(t('browserProfile.toast.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  }, [complete, data, onSave, t]);

  const requestReload = useCallback(() => {
    setStale(false);
    setDraft(undefined);
    onRetry();
  }, [onRetry]);

  // Nothing to amend before there is a fingerprint: that card offers 生成 instead.
  const editing = canOperate && Boolean(data) && Boolean(selection) && Boolean(visible);

  /**
   * Opening adopts whatever the platform is running now (`draft` cleared), closing throws the
   * choice away — the summary behind the modal must never disagree with what is stored.
   */
  const editModal = useInfraEditModal({
    beginEdit: () => setDraft(undefined),
    cancelEdit: () => setDraft(undefined),
    dirty,
    saveCount: savedCount,
  });

  return {
    complete,
    dirty,
    editModal,
    editing,
    patch,
    regenerating,
    requestReload,
    requestRegenerate,
    requestSave,
    saving,
    selection,
    stale,
    visible,
  };
};
