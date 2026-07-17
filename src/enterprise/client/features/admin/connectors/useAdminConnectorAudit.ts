'use client';

import { adminConnectorAuditService } from '@/enterprise/client/services/adminConnectorAudit';
import { useClientDataSWR } from '@/libs/swr';

import { buildAdminConnectorAuditKey } from './swrKeys';

export const useAdminConnectorAudit = (params: {
  connectorId: string;
  cursor?: string | null;
  enabled: boolean;
  limit?: number;
}) => {
  const key = buildAdminConnectorAuditKey(params);

  return useClientDataSWR(
    key,
    () =>
      adminConnectorAuditService.list({
        connectorId: params.connectorId,
        cursor: params.cursor ?? undefined,
        limit: params.limit,
      }),
    { revalidateOnFocus: false },
  );
};
