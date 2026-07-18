import type { TFunction } from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

/** Stable, localized Agent-admin error copy. Never returns an untrusted backend message. */
export const getAdminAgentErrorMessage = (cause: unknown, t: TFunction<'admin'>): string => {
  const mapped = mapEnterpriseError(cause);
  return mapped
    ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
    : t('agentCatalog.errors.generic');
};
