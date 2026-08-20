'use client';

import { createModal, useModalContext } from '@lobehub/ui/base-ui';
import i18next from 'i18next';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import { TASK_TEMPLATE_MAX_CONNECTORS } from '@/server/enterprise/contracts/adminTaskTemplates';

import TaskTemplateEditorForm from './TaskTemplateEditorForm';
import type { AdminTaskTemplateItem } from './types';
import { toTaskTemplatePayload, useTaskTemplateForm } from './useTaskTemplateForm';

export type TaskTemplateEditorPayload = ReturnType<typeof toTaskTemplatePayload>;

export interface TaskTemplateEditorModalProps {
  /** Omitted for create; the existing row (with its CAS revision) for edit. */
  item?: AdminTaskTemplateItem;
  /**
   * Refresh the list and resolve the row's current server state.
   * `undefined` means the row is gone (deleted by whoever won the conflict); a rejection means
   * the refresh itself failed. Both are reported in place — the editor stays open either way.
   */
  onReload?: (item: AdminTaskTemplateItem) => Promise<AdminTaskTemplateItem | undefined>;
  /**
   * @param item the row this editor is bound to right now — `undefined` for create.
   *   A conflict reload reopens the modal against the *refreshed* row, so the caller must save
   *   against this one and never against whatever it captured when it first opened the editor,
   *   or the stale CAS token conflicts forever.
   */
  onSubmit: (payload: TaskTemplateEditorPayload, item?: AdminTaskTemplateItem) => Promise<void>;
}

const TaskTemplateEditorContent = memo<TaskTemplateEditorModalProps>(
  ({ item, onReload, onSubmit }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [conflict, setConflict] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [reloadError, setReloadError] = useState<string | undefined>();
    const messages = useMemo(
      () => ({
        connectorLimit: t('taskTemplateCatalog.form.errors.connectorLimit', {
          max: TASK_TEMPLATE_MAX_CONNECTORS,
        }),
        connectorRetired: t('taskTemplateCatalog.form.errors.connectorRetired'),
        connectors: t('taskTemplateCatalog.form.errors.connectorIdentifier'),
        cron: t('taskTemplateCatalog.form.errors.cron'),
        instruction: t('taskTemplateCatalog.form.errors.instruction'),
        title: t('taskTemplateCatalog.form.errors.title'),
      }),
      [t],
    );
    const form = useTaskTemplateForm(item, messages);

    const handleSubmit = async () => {
      if (!form.valid || form.submitting) return;
      form.setSubmitting(true);
      form.setSubmitError(undefined);
      try {
        await onSubmit(toTaskTemplatePayload(form.state), item);
        close();
      } catch (error) {
        const mapped = mapEnterpriseError(error);
        // The captured revision can never win again, so retrying in place is futile: say what
        // happened and offer a reload instead of a generic "save failed".
        if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
          setConflict(true);
          form.setSubmitError(undefined);
        } else if (mapped?.code === 'PLATFORM_INVALID_INPUT') {
          form.setSubmitError(t('taskTemplateCatalog.form.errors.identifierTaken'));
        } else {
          // A failure keeps the draft on screen so nothing the operator typed is lost.
          form.setSubmitError(t('taskTemplateCatalog.toast.error'));
        }
      } finally {
        form.setSubmitting(false);
      }
    };

    /**
     * Reload only *swaps* the editor once a fresh row is in hand. Closing first would throw the
     * draft away even when the refresh fails or the row turns out to be deleted.
     */
    const handleReload = useCallback(async () => {
      if (!item || !onReload || reloading) return;
      setReloading(true);
      setReloadError(undefined);
      try {
        const current = await onReload(item);
        if (!current) {
          setReloadError(t('taskTemplateCatalog.form.conflictDeleted'));
          return;
        }
        close();
        openTaskTemplateEditorModal({ item: current, onReload, onSubmit });
      } catch {
        setReloadError(t('taskTemplateCatalog.form.conflictReloadFailed'));
      } finally {
        setReloading(false);
      }
    }, [close, item, onReload, onSubmit, reloading, t]);

    return (
      <TaskTemplateEditorForm
        conflict={conflict}
        dispatch={form.dispatch}
        errors={form.errors}
        mode={item ? 'edit' : 'create'}
        reloadError={reloadError}
        reloading={reloading}
        state={form.state}
        submitError={form.submitError}
        submitting={form.submitting}
        valid={form.valid && !conflict}
        onReload={item && onReload ? () => void handleReload() : undefined}
        onSubmit={() => void handleSubmit()}
      />
    );
  },
);

TaskTemplateEditorContent.displayName = 'AdminTaskTemplateEditorContent';

export const openTaskTemplateEditorModal = (props: TaskTemplateEditorModalProps) =>
  createModal({
    content: <TaskTemplateEditorContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t(
      props.item ? 'taskTemplateCatalog.edit.title' : 'taskTemplateCatalog.create.title',
      { ns: 'admin' },
    ),
    width: 'min(94vw, 760px)',
  });
