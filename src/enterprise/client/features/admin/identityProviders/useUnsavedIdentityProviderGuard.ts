'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

export const useUnsavedIdentityProviderGuard = (dirty: boolean): void => {
  const { t } = useTranslation('admin');
  const leaveModalRef = useRef<ReturnType<typeof confirmModal> | null>(null);
  const blocker = useBlocker(dirty);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      leaveModalRef.current?.close();
      leaveModalRef.current = null;
      return;
    }
    if (leaveModalRef.current) return;
    leaveModalRef.current = confirmModal({
      cancelText: t('identityProviders.unsaved.stay'),
      content: t('identityProviders.unsaved.description'),
      okText: t('identityProviders.unsaved.discard'),
      title: t('identityProviders.unsaved.title'),
      onCancel: () => {
        leaveModalRef.current = null;
        blocker.reset?.();
      },
      onOk: () => {
        leaveModalRef.current = null;
        blocker.proceed?.();
      },
    });
  }, [blocker.proceed, blocker.reset, blocker.state, t]);

  useEffect(
    () => () => {
      leaveModalRef.current?.destroy();
      leaveModalRef.current = null;
    },
    [],
  );
};
