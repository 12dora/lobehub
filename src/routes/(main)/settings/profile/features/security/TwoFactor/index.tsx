'use client';

import { createModal, type ModalInstance } from '@lobehub/ui/base-ui';

import TwoFactorContent, { type TwoFactorDismissGuard } from './TwoFactorContent';

/**
 * `title: null` suppresses the base-ui header and its close button — the content owns its
 * heading and an explicit Close, and one of its screens must not be closable at all.
 *
 * `maskClosable: false` protects half-typed passwords from a stray backdrop click; the
 * `onOpenChange` veto below covers Escape, which base-ui commits *before* calling back, so
 * the only way to refuse it is to re-open. That veto is armed solely while recovery codes
 * are on screen: they are shown exactly once, and a mis-keyed Escape there is a lockout.
 */
export const openTwoFactorModal = (): ModalInstance => {
  const dismissGuardRef: { current: TwoFactorDismissGuard } = {
    current: { closedExplicitly: false, locked: false },
  };

  const instance = createModal({
    content: <TwoFactorContent dismissGuardRef={dismissGuardRef} />,
    footer: null,
    maskClosable: false,
    title: null,
    width: 'min(92vw, 520px)',
    onOpenChange: (open) => {
      if (open) return;
      const { closedExplicitly, locked } = dismissGuardRef.current;
      if (!closedExplicitly && locked) instance.update({ open: true });
    },
  });

  return instance;
};

export default openTwoFactorModal;
