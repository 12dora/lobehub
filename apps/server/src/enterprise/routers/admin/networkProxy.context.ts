import type { LobeChatDatabase } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type {
  NETWORK_PROXY_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES,
} from './networkProxySupport';

export type NetworkProxyCtx = {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod;
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
