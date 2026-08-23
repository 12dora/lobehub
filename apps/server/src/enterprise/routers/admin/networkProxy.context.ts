import type { LobeChatDatabase } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type {
  NETWORK_PROXY_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
} from './networkProxySupport';

export type NetworkProxyCtx = {
  authenticatedAt?: Date | null;
  // `| null` because that is what the request context really carries: an API-key request has no
  // auth method, and a resolver whose ctx cannot represent that is not a resolver tRPC accepts.
  authMethod?: AuthMethod | null;
  serverDB: LobeChatDatabase;
  userId?: string | null;
};

export const assertNetworkProxyReauth = async (
  ctx: NetworkProxyCtx,
  denied: {
    action: (typeof NETWORK_PROXY_AUDIT_ACTIONS)[keyof typeof NETWORK_PROXY_AUDIT_ACTIONS];
    reason?: string | null;
    targetId: string;
    targetType: (typeof NETWORK_PROXY_AUDIT_TARGET_TYPES)[keyof typeof NETWORK_PROXY_AUDIT_TARGET_TYPES];
  },
) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    denied: {
      action: denied.action,
      actorUserId: ctx.userId!,
      reason: denied.reason,
      targetId: denied.targetId,
      targetType: denied.targetType,
    },
    serverDB: ctx.serverDB,
  });
