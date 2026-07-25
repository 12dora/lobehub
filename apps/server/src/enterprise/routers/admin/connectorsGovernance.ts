import { TRPCError } from '@trpc/server';
import { ZodError } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  CONNECTOR_GOVERNANCE_RESOURCE_ID,
  CONNECTOR_GOVERNANCE_RESOURCE_TYPE,
} from '@/types/platform/connectorGovernance';

import {
  adminConnectorGovernanceGetOutputSchema,
  adminConnectorGovernanceRevisionOutputSchema,
  adminConnectorSetSharedAuthorizationInputSchema,
  adminConnectorUpdateBuiltinToolPolicyInputSchema,
} from '../../contracts/platformConnectorGovernance';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import {
  ConnectorGovernanceAdminService,
  ConnectorGovernanceOwnerNotFoundError,
} from '../../services/connectorGovernance/adminService';

const governanceProcedure = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/** Transport boundary: only stable codes and error classes may leave this module.
 *  `action` is an operation path for error logs — not necessarily an audit-catalog token.
 */
const executeGovernanceOperation = async <T>(
  action: string,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof PlatformRevisionConflictError) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      });
    }
    if (error instanceof ConnectorGovernanceOwnerNotFoundError || error instanceof ZodError) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      });
    }
    console.error('[admin.connectors.governance] operation failed', {
      action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'PLATFORM_CONNECTOR_OPERATION_FAILED',
    });
  }
};

/** Dangerous-action reauth with a best-effort denied audit (no secret material involved). */
const assertGovernanceDangerousReauth = async (params: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    serverDB: params.serverDB,
    denied: {
      action: params.action,
      actorUserId: params.actorUserId,
      reason: params.reason,
      targetId: CONNECTOR_GOVERNANCE_RESOURCE_ID,
      targetType: CONNECTOR_GOVERNANCE_RESOURCE_TYPE,
    },
  });

/** Governance procedures spread into `adminConnectorsRouter` (admin.connectors.*). */
export const adminConnectorGovernanceProcedures = {
  /** Published governance doc + effective-enforced hint for the admin UI. */
  getGovernance: governanceProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_READ))
    .output(adminConnectorGovernanceGetOutputSchema)
    .query(async ({ ctx }) =>
      executeGovernanceOperation('admin.connectors.getGovernance', () =>
        new ConnectorGovernanceAdminService(ctx.serverDB).get(),
      ),
    ),

  /**
   * Designate (or clear) the org-wide shared OAuth identity.
   * Dangerous: switches whose authorization every managed user runs with.
   */
  setSharedAuthorization: governanceProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE))
    .input(adminConnectorSetSharedAuthorizationInputSchema)
    .output(adminConnectorGovernanceRevisionOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeGovernanceOperation('admin.connectors.setSharedAuthorization', async () => {
        await assertGovernanceDangerousReauth({
          action: 'admin.connectors.setSharedAuthorization',
          actorUserId: ctx.userId!,
          authenticatedAt: ctx.authenticatedAt,
          authMethod: ctx.authMethod,
          reason: input.reason,
          serverDB: ctx.serverDB,
        });
        return new ConnectorGovernanceAdminService(ctx.serverDB).setSharedAuthorization({
          actorUserId: ctx.userId!,
          expectedRevision: input.expectedRevision,
          ownerUserId: input.ownerUserId,
          reason: input.reason,
        });
      }),
    ),

  /** Replace the builtin tool permission matrix and publish in one shot. */
  updateBuiltinToolPolicy: governanceProcedure
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE))
    .input(adminConnectorUpdateBuiltinToolPolicyInputSchema)
    .output(adminConnectorGovernanceRevisionOutputSchema)
    .mutation(async ({ ctx, input }) =>
      executeGovernanceOperation('admin.connectors.updateBuiltinToolPolicy', () =>
        new ConnectorGovernanceAdminService(ctx.serverDB).updateBuiltinToolPolicy({
          actorUserId: ctx.userId!,
          expectedRevision: input.expectedRevision,
          policies: input.policies,
          reason: input.reason,
        }),
      ),
    ),
};
