'use client';

import { createModal, useModalContext } from '@lobehub/ui/base-ui';
import i18next from 'i18next';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  AGENT_TEMPLATE_MAX_TAGS,
  AGENT_TEMPLATE_TAG_MAX,
} from '@/server/enterprise/contracts/adminAgentTemplates';

import AgentTemplateEditorForm from './AgentTemplateEditorForm';
import type { AgentTemplateReloadResult } from './reloadAgentTemplate';
import type { AdminAgentTemplateItem } from './types';
import { toAgentTemplatePayload, useAgentTemplateForm } from './useAgentTemplateForm';

export type AgentTemplateEditorPayload = ReturnType<typeof toAgentTemplatePayload>;

export interface AgentTemplateEditorModalProps {
  /** Omitted for create; the existing row (with its CAS revision) for edit. */
  item?: AdminAgentTemplateItem;
  /**
   * Re-read the row's current server state.
   *
   * Three outcomes, all reported in place — the editor stays open and keeps the draft either way:
   * `found` swaps the editor onto the fresh row, `deleted` says so, and `unverified` (the read
   * failed, or could not prove absence) offers another try instead of claiming a deletion.
   */
  onReload?: (item: AdminAgentTemplateItem) => Promise<AgentTemplateReloadResult>;
  /**
   * @param item the row this editor is bound to right now — `undefined` for create.
   *   A conflict reload reopens the modal against the *refreshed* row, so the caller must save
   *   against this one and never against whatever it captured when it first opened the editor,
   *   or the stale CAS token conflicts forever.
   */
  onSubmit: (payload: AgentTemplateEditorPayload, item?: AdminAgentTemplateItem) => Promise<void>;
}

const AgentTemplateEditorContent = memo<AgentTemplateEditorModalProps>(
  ({ item, onReload, onSubmit }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [conflict, setConflict] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [reloadError, setReloadError] = useState<string | undefined>();
    const messages = useMemo(
      () => ({
        systemRole: t('agentTemplateCatalog.form.errors.systemRole'),
        tagLength: t('agentTemplateCatalog.form.errors.tagLength', {
          max: AGENT_TEMPLATE_TAG_MAX,
        }),
        tags: t('agentTemplateCatalog.form.errors.tagLimit', { max: AGENT_TEMPLATE_MAX_TAGS }),
        title: t('agentTemplateCatalog.form.errors.title'),
      }),
      [t],
    );
    const form = useAgentTemplateForm(item, messages);

    const handleSubmit = async () => {
      if (!form.valid || form.submitting) return;
      form.setSubmitting(true);
      form.setSubmitError(undefined);
      try {
        await onSubmit(toAgentTemplatePayload(form.state), item);
        close();
      } catch (error) {
        const mapped = mapEnterpriseError(error);
        // The captured revision can never win again, so retrying in place is futile: say what
        // happened and offer a reload instead of a generic "save failed".
        if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
          setConflict(true);
          form.setSubmitError(undefined);
        } else if (mapped?.code === 'PLATFORM_INVALID_INPUT') {
          form.setSubmitError(t('agentTemplateCatalog.form.errors.identifierTaken'));
        } else {
          // A failure keeps the draft on screen so nothing the operator typed is lost.
          form.setSubmitError(t('agentTemplateCatalog.toast.error'));
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
        const result = await onReload(item);
        if (result.status === 'deleted') {
          setReloadError(t('agentTemplateCatalog.form.conflictDeleted'));
          return;
        }
        // Could not prove anything: offer the retry rather than tell the operator to give up on
        // a draft whose row may well still be there.
        if (result.status === 'unverified') {
          setReloadError(t('agentTemplateCatalog.form.conflictReloadFailed'));
          return;
        }
        close();
        openAgentTemplateEditorModal({ item: result.item, onReload, onSubmit });
      } catch {
        setReloadError(t('agentTemplateCatalog.form.conflictReloadFailed'));
      } finally {
        setReloading(false);
      }
    }, [close, item, onReload, onSubmit, reloading, t]);

    return (
      <AgentTemplateEditorForm
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

AgentTemplateEditorContent.displayName = 'AdminAgentTemplateEditorContent';

export const openAgentTemplateEditorModal = (props: AgentTemplateEditorModalProps) =>
  createModal({
    content: <AgentTemplateEditorContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t(
      props.item ? 'agentTemplateCatalog.edit.title' : 'agentTemplateCatalog.create.title',
      { ns: 'admin' },
    ),
    width: 'min(94vw, 760px)',
  });
