import { lambdaClient } from '@/libs/trpc/client';

export interface AdminConnectorAuditListInput {
  connectorId: string;
  cursor?: string;
  limit?: number;
}

/** Typed adapter over the existing permission-gated `admin.audit.list` procedure. */
class AdminConnectorAuditService {
  list = async ({ connectorId, cursor, limit = 50 }: AdminConnectorAuditListInput) =>
    lambdaClient.admin.audit.list.query({
      cursor,
      limit,
      targetId: connectorId,
      targetType: 'connector',
    });
}

export const adminConnectorAuditService = new AdminConnectorAuditService();

export type AdminConnectorAuditListOutput = Awaited<ReturnType<AdminConnectorAuditService['list']>>;
