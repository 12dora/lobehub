'use client';

import { Button, createModal, ModalFooter } from '@lobehub/ui/base-ui';
import { createElement, Fragment, useEffect, useRef } from 'react';
import type { BlockerFunction } from 'react-router';
import { useBlocker } from 'react-router';

export interface UnsavedChangesGuardMessages {
  cancelText: string;
  content: string;
  okText: string;
  title: string;
}

export interface UseUnsavedChangesGuardOptions {
  /**
   * When true, registers `beforeunload` and (unless `shouldBlock` is provided)
   * blocks in-app navigations via `useBlocker`.
   */
  enabled: boolean;
  messages: UnsavedChangesGuardMessages;
  /** Runs once before the blocked navigation is reset. */
  onCancel?: () => void;
  /** Runs once before the blocked navigation proceeds. */
  onProceed?: () => void;
  /**
   * Optional override for the react-router blocker condition.
   * Defaults to `enabled`. Use a function when same-path tab switches must pass
   * through while real page exits stay blocked.
   */
  shouldBlock?: boolean | BlockerFunction;
}

/** Ensures a blocked navigation resolves exactly once even under repeated modal events. */
export const createUnsavedNavigationDecision = (callbacks: {
  onCancel: () => void;
  onProceed: () => void;
}): { cancel: () => void; proceed: () => void } => {
  let resolved = false;
  const resolveOnce = (callback: () => void) => {
    if (resolved) return;
    resolved = true;
    callback();
  };
  return {
    cancel: () => resolveOnce(callbacks.onCancel),
    proceed: () => resolveOnce(callbacks.onProceed),
  };
};

/**
 * Shared dirty-draft leave guard for admin editors:
 * - `beforeunload` while `enabled`
 * - `useBlocker` + base-ui `createModal` for SPA navigations
 * - once-only modal resolution + destroy on unmount
 * - Escape / close-icon / mask dismissals all take the cancel (stay) path so the
 *   router blocker is never stranded in `blocked`
 */
export const useUnsavedChangesGuard = ({
  enabled,
  messages,
  shouldBlock,
  onProceed,
  onCancel,
}: UseUnsavedChangesGuardOptions): void => {
  const leaveModalRef = useRef<ReturnType<typeof createModal> | null>(null);
  const callbacksRef = useRef({ onCancel, onProceed });
  callbacksRef.current = { onCancel, onProceed };
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const blockerCondition = shouldBlock === undefined ? enabled : shouldBlock;
  const blocker = useBlocker(blockerCondition);
  const blockerProceed = blocker.proceed;
  const blockerReset = blocker.reset;
  const blockerState = blocker.state;

  useEffect(() => {
    if (!enabled) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [enabled]);

  useEffect(() => {
    if (blockerState !== 'blocked') {
      leaveModalRef.current?.close();
      leaveModalRef.current = null;
      return;
    }
    // Rebuild on every fresh blocked navigation so re-attempts re-open the prompt
    // after a prior Stay/dismiss (the previous instance is destroyed first).
    leaveModalRef.current?.destroy();

    const currentMessages = messagesRef.current;
    const decision = createUnsavedNavigationDecision({
      onCancel: () => {
        leaveModalRef.current = null;
        callbacksRef.current.onCancel?.();
        blockerReset?.();
      },
      onProceed: () => {
        leaveModalRef.current = null;
        callbacksRef.current.onProceed?.();
        blockerProceed?.();
      },
    });

    // Use createModal (not confirmModal) so we can wire onOpenChange: base-ui
    // confirmModal only fires onCancel/onOk for the footer buttons; Escape, the
    // close icon, and mask clicks would otherwise leave the router blocked.
    const instance = createModal({
      content: createElement(
        Fragment,
        null,
        createElement('div', { style: { padding: '12px 16px' } }, currentMessages.content),
        createElement(
          ModalFooter,
          null,
          createElement(
            Button,
            {
              onClick: () => {
                decision.cancel();
                instance.close();
              },
            },
            currentMessages.cancelText,
          ),
          createElement(
            Button,
            {
              type: 'primary',
              onClick: () => {
                decision.proceed();
                instance.close();
              },
            },
            currentMessages.okText,
          ),
        ),
      ),
      maskClosable: false,
      onOpenChange: (open) => {
        if (open) return;
        // Passive dismiss (Escape / close icon) or post-button close — resolveOnce
        // makes a second cancel after proceed a no-op.
        leaveModalRef.current = null;
        decision.cancel();
      },
      styles: { content: { padding: 0 } },
      title: currentMessages.title,
      width: 420,
    });
    leaveModalRef.current = instance;
  }, [blockerProceed, blockerReset, blockerState]);

  useEffect(
    () => () => {
      leaveModalRef.current?.destroy();
      leaveModalRef.current = null;
    },
    [],
  );
};
