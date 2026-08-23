'use client';

import { confirmModal, type ModalInstance } from '@lobehub/ui/base-ui';
import i18next from 'i18next';

import type { CreateUserModalDismissGuard } from './types';

/**
 * `onOpenChange` for the create-user modal: the last line of defence against losing a
 * mutation in flight, the one-time credentials panel, or a filled-in form.
 */
export const createCreateUserDismissHandler = ({
  abortControllerRef,
  dismissGuardRef,
  getInstance,
}: {
  abortControllerRef: { current: AbortController | null };
  dismissGuardRef: { current: CreateUserModalDismissGuard };
  /** Resolved lazily: the instance only exists once `createModal` has returned. */
  getInstance: () => ModalInstance;
}) => {
  return (open: boolean) => {
    if (open) return;
    const guard = dismissGuardRef.current;
    const { closedExplicitly, phase } = guard;
    // base-ui commits the close (closeModal) BEFORE this callback for every
    // framework dismissal (Escape included, despite maskClosable: false). While a
    // create is in flight or the one-time credentials panel is showing, veto by
    // re-opening synchronously — same event batch, so the closed state never
    // renders. Explicit Cancel/Done use useModalContext().close(), which skips
    // onOpenChange entirely; closedExplicitly keeps a late dismissal during the
    // exit animation from resurrecting the modal.
    if (!closedExplicitly && (phase === 'mutating' || phase === 'success')) {
      getInstance().update({ open: true });
      return;
    }
    if (!closedExplicitly && phase === 'idle' && guard.dirty) {
      // base-ui has already committed the Escape close. Restore the form in the same
      // event batch, then require an explicit destructive choice.
      getInstance().update({ open: true });
      if (guard.discardPromptOpen) return;
      guard.discardPromptOpen = true;
      confirmModal({
        cancelText: i18next.t('users.modals.create.unsaved.stay', { ns: 'admin' }),
        content: i18next.t('users.modals.create.unsaved.description', { ns: 'admin' }),
        okButtonProps: { danger: true },
        okText: i18next.t('users.modals.create.unsaved.discard', { ns: 'admin' }),
        title: i18next.t('users.modals.create.unsaved.title', { ns: 'admin' }),
        onCancel: () => {
          guard.discardPromptOpen = false;
        },
        onOk: () => {
          guard.closedExplicitly = true;
          guard.dirty = false;
          guard.discardPromptOpen = false;
          abortControllerRef.current?.abort();
          abortControllerRef.current = null;
          getInstance().close();
        },
      });
      return;
    }
    // Escape / dismiss / close — abort immediately, do not wait for unmount.
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  };
};
