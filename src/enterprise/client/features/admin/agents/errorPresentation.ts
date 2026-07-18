import type { TFunction } from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

const GENERIC_ERROR_KEY = 'agentCatalog.errors.generic';

const keyForMappedAction = (
  action: NonNullable<ReturnType<typeof mapEnterpriseError>>['action'],
): string => {
  switch (action) {
    case 'reauth': {
      return 'users.errors.reauthRequired';
    }
    case 'contact_admin':
    case 'request_access': {
      return 'users.errors.permissionDenied';
    }
    case 'retry': {
      return 'agentCatalog.conflict.description';
    }
    default: {
      return GENERIC_ERROR_KEY;
    }
  }
};

const translateOrGeneric = (key: string, t: TFunction<'admin'>): string => {
  const translated = t(key as never);
  if (translated && translated !== key) return translated;

  const generic = t(GENERIC_ERROR_KEY);
  return generic && generic !== GENERIC_ERROR_KEY ? generic : GENERIC_ERROR_KEY;
};

/** Stable, localized Agent-admin error copy. Never returns an untrusted backend message. */
export const getAdminAgentErrorMessage = (cause: unknown, t: TFunction<'admin'>): string => {
  const mapped = mapEnterpriseError(cause);
  return translateOrGeneric(mapped ? keyForMappedAction(mapped.action) : GENERIC_ERROR_KEY, t);
};
