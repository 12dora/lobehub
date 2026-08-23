import i18n from 'i18next';

/**
 * Imperative modals are opened outside React, so they cannot use `useTranslation`.
 * Kept in one place so every user action modal resolves keys against the same namespace.
 */
export const t = (key: string, opts?: Record<string, unknown>) =>
  String(i18n.t(key as never, { ns: 'admin', ...opts }));
