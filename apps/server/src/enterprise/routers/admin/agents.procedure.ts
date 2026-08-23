import { authedProcedure, preAccessAuthedProcedure } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import { assertAgentDangerousReauth, assertAgentFeatureEnabled } from './agentsSupport';

export const adminBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const rolloutBase = preAccessAuthedProcedure
  .use(({ next }) => {
    // This synchronous env-only gate MUST precede serverDatabase, active-user and RBAC. With
    // ADMIN=1 + MANAGED_AGENTS=0 every rollout procedure exits with zero database/guard work.
    assertAgentFeatureEnabled();
    return next();
  })
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

export const rolloutMutation = async (params: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertAgentDangerousReauth>[0]['authMethod'];
  reason?: string | null;
  serverDB: Parameters<typeof assertAgentDangerousReauth>[0]['serverDB'];
  targetId: string;
}) =>
  assertAgentDangerousReauth({
    action: params.action,
    actorUserId: params.actorUserId,
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    reason: params.reason,
    serverDB: params.serverDB,
    targetId: params.targetId,
  });
