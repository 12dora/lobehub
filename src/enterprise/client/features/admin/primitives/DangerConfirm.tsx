'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import i18n from 'i18next';
import type { ReactNode } from 'react';

export interface DangerConfirmOptions {
  /** Optional custom cancel label */
  cancelText?: string;
  /** Optional custom confirm label */
  confirmText?: string;
  /**
   * Body copy. A plain string is the common case; a node lets a caller list several
   * consequences as real block elements (newlines inside a string collapse to spaces).
   */
  content: ReactNode;
  onConfirm: () => void | Promise<void>;
  title: string;
}

/**
 * Imperative destructive confirmation using base-ui confirmModal.
 * Prefer this over antd Popconfirm / custom dialogs for admin write actions.
 */
export const openDangerConfirm = (options: DangerConfirmOptions): void => {
  const t = i18n.getFixedT(null, 'admin');

  confirmModal({
    cancelText: options.cancelText ?? t('primitives.dangerConfirm.cancel'),
    content: options.content,
    okButtonProps: { danger: true },
    okText: options.confirmText ?? t('primitives.dangerConfirm.confirm'),
    onOk: async () => {
      await options.onConfirm();
    },
    title: options.title,
  });
};
