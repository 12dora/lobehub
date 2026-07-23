'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useEffect, useRef } from 'react';
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
 * - `useBlocker` + base-ui `confirmModal` for SPA navigations
 * - once-only modal resolution + destroy on unmount
 */
export const useUnsavedChangesGuard = ({
  enabled,
  messages,
  shouldBlock,
  onProceed,
  onCancel,
}: UseUnsavedChangesGuardOptions): void => {
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);
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
    if (leaveModalRef.current) return;

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

    leaveModalRef.current = confirmModal({
      cancelText: currentMessages.cancelText,
      content: currentMessages.content,
      okText: currentMessages.okText,
      onCancel: decision.cancel,
      onOk: decision.proceed,
      title: currentMessages.title,
    });
  }, [blockerProceed, blockerReset, blockerState]);

  useEffect(
    () => () => {
      leaveModalRef.current?.destroy();
      leaveModalRef.current = null;
    },
    [],
  );
};
