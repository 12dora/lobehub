import type { LobeChatDatabase } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { AUDIT_ACTION } from '../../services/audit/auditActionCatalog';

export type SystemHandlerCtx = {
  authenticatedAt?: Date | null;
  // `| null` because that is what the request context really carries: an API-key request has no
  // auth method, and a resolver whose ctx cannot represent that is not a resolver tRPC accepts.
  authMethod?: AuthMethod | null;
  serverDB: LobeChatDatabase;
  userId?: string | null;
};

export const assertRestartReauth = async (
  ctx: SystemHandlerCtx,
  input: { reason: string; requestId: string },
  action: typeof AUDIT_ACTION.SYSTEM_PREPARE_RESTART | typeof AUDIT_ACTION.SYSTEM_REQUEST_RESTART,
): Promise<void> =>
  assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    serverDB: ctx.serverDB,
    denied: {
      action,
      actorUserId: ctx.userId!,
      reason: input.reason,
      requestId: input.requestId,
      targetId: 'identity_provider_runtime',
      targetType: 'system',
    },
  });

export const assertJobMutationReauth = async (
  ctx: SystemHandlerCtx,
  input: { jobId: string; reason?: string | null; requestId: string },
  action: typeof AUDIT_ACTION.SYSTEM_JOBS_CANCEL | typeof AUDIT_ACTION.SYSTEM_JOBS_RETRY,
): Promise<void> =>
  assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    serverDB: ctx.serverDB,
    denied: {
      action,
      actorUserId: ctx.userId!,
      reason: input.reason,
      requestId: input.requestId,
      targetId: input.jobId,
      targetType: 'platform_job',
    },
  });
