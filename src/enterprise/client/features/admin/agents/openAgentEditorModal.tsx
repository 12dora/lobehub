'use client';

import { confirmModal, createModal, type ModalInstance } from '@lobehub/ui/base-ui';
import i18next from 'i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { AgentEditorForm } from './AgentEditorForm';
import type { AdminAgentDetailOutput, AdminPlatformAgentSaveOutput } from './types';

export interface AgentEditorModalProps {
  /** Present → edit the assistant; absent → create a new one. */
  agent?: AdminAgentDetailOutput;
  authMethod?: AdminReauthAuthMethod | null;
  /** Called after the assistant is saved and live; the output carries the published version. */
  onSaved?: (output: AdminPlatformAgentSaveOutput, created: boolean) => Promise<void> | void;
}

/**
 * The single entry point for authoring a platform assistant — create and edit share one modal.
 * Saving appends an immutable version and publishes it in one server transaction, so the modal
 * has no draft lifecycle: it either commits live or stays open with the failure explained.
 */
export const openAgentEditorModal = ({
  agent,
  authMethod,
  onSaved,
}: AgentEditorModalProps): ModalInstance => {
  // Tracks unsaved input so any dismissal (Escape / X / Cancel) can confirm before discarding.
  const dirtyRef = { current: false };
  // True while a save/create is in flight. Dismissal is then vetoed outright — no prompt, because
  // there is nothing for the admin to decide until the server answers.
  const pendingRef = { current: false };

  const forceClose = () => {
    dirtyRef.current = false;
    instance.close();
  };

  /** base-ui may already have flipped the modal closed — pin it back open. */
  const keepOpen = () => instance.update({ open: true });

  /** Keep the modal open and ask first; used by every dismissal path while input is unsaved. */
  const confirmDiscard = () => {
    // Pin the modal open until the admin decides.
    keepOpen();
    confirmModal({
      cancelText: i18next.t('agentCatalog.unsaved.stay', { ns: 'admin' }),
      content: i18next.t('agentCatalog.unsaved.description', { ns: 'admin' }),
      okText: i18next.t('agentCatalog.unsaved.leave', { ns: 'admin' }),
      title: i18next.t('agentCatalog.unsaved.title', { ns: 'admin' }),
      onOk: forceClose,
    });
  };

  const instance: ModalInstance = createModal({
    content: (
      <AgentEditorForm
        agent={agent}
        authMethod={authMethod}
        dirtyRef={dirtyRef}
        pendingRef={pendingRef}
        onClose={forceClose}
        onSaved={onSaved}
        onCancel={() => {
          // Cancel is an explicit dismissal, guarded exactly like Escape / the close button.
          if (pendingRef.current) return keepOpen();
          return dirtyRef.current ? confirmDiscard() : forceClose();
        }}
      />
    ),
    footer: null,
    maskClosable: false,
    // The form owns its own scroll region and a pinned footer, so the modal body must NOT scroll:
    // Cancel / Save / errors stay reachable no matter how long the role prompt gets.
    styles: {
      content: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '80vh',
        minHeight: 0,
        overflow: 'hidden',
        padding: 0,
      },
    },
    title: agent
      ? i18next.t('agentCatalog.editor.title.edit', { ns: 'admin' })
      : i18next.t('agentCatalog.editor.title.create', { ns: 'admin' }),
    width: 'min(94vw, 780px)',
    // Only user-initiated closes fire this; a programmatic close() (save / discard) does not.
    onOpenChange: (open) => {
      if (open) return;
      // A write is in flight: veto silently, there is nothing to discard or confirm yet.
      if (pendingRef.current) return keepOpen();
      if (!dirtyRef.current) return;
      confirmDiscard();
    },
  });
  return instance;
};
