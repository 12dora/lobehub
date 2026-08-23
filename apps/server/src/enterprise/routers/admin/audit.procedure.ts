import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AuditTargetType } from '../../services/audit/auditActionCatalog';

const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const auditRead = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ));
export const auditConversationRead = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ),
);
export const auditExport = adminBase.use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_EXPORT));
export const auditRetentionOperate = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE),
);
export const auditPolicyUpdate = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE),
);
export const auditLegalHoldManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE),
);

export const assertAuditDangerousReauth = async (params: {
  action:
    | 'admin.audit.exports.cancel'
    | 'admin.audit.exports.create'
    | 'admin.audit.exports.download'
    | 'admin.audit.legalHolds.create'
    | 'admin.audit.legalHolds.release'
    | 'admin.audit.policy.update'
    | 'admin.audit.retention.cancel'
    | 'admin.audit.retention.dryRun'
    | 'admin.audit.retention.run';
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  serverDB: LobeChatDatabase;
  targetId?: string;
  targetType: AuditTargetType;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    serverDB: params.serverDB,
    denied: {
      action: params.action,
      actorUserId: params.actorUserId,
      reason: params.reason,
      targetId: params.targetId ?? null,
      targetType: params.targetType,
    },
  });

/** Server-derived permissions from withPlatformPermission — never client-supplied. */
export const platformAuthPermissions = (ctx: {
  platformAuth?: { permissions?: readonly string[] };
}): readonly string[] | undefined => ctx.platformAuth?.permissions;
