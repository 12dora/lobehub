import { lambdaClient } from '@/libs/trpc/client';

export interface AdminConnectorAuditListInput {
  connectorId: string;
  cursor?: string;
  limit?: number;
}

/** Typed adapter over the existing permission-gated `admin.audit.list` procedure. */
class AdminConnectorAuditService {
  // No local page-size default: an omitted `limit` goes to the server as `undefined` so the
  // audit contract's default applies — the same number the SWR key normalizes to.
  list = async ({ connectorId, cursor, limit }: AdminConnectorAuditListInput) =>
    lambdaClient.admin.audit.list.query({
      cursor,
      limit,
      targetId: connectorId,
      targetType: 'connector',
    });
}

export const adminConnectorAuditService = new AdminConnectorAuditService();

export type AdminConnectorAuditListOutput = Awaited<ReturnType<AdminConnectorAuditService['list']>>;
