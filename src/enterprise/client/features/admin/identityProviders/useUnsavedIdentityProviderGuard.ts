'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useUnsavedChangesGuard } from '../primitives/useUnsavedChangesGuard';

/** @deprecated Prefer `useUnsavedChangesGuard` directly; kept as a thin domain wrapper. */
export const useUnsavedIdentityProviderGuard = (dirty: boolean): void => {
  const { t } = useTranslation('admin');
  const messages = useMemo(
    () => ({
      cancelText: t('identityProviders.unsaved.stay'),
      content: t('identityProviders.unsaved.description'),
      okText: t('identityProviders.unsaved.discard'),
      title: t('identityProviders.unsaved.title'),
    }),
    [t],
  );
  useUnsavedChangesGuard({ enabled: dirty, messages });
};
