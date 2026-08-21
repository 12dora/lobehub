/**
 * Admin user session retention and revocation.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';

import { AdminUserModel } from '@/database/models/adminUser';
import { session } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';

import type { AdminUsersRevokeSessionsInput } from '../../contracts/adminUsers';
import { deleteBetterAuthSecondaryStorageSessions } from './betterAuthSecondaryStorage';
import { AdminUserNotFoundError, InvalidRetainedSessionError } from './errors';
import { AdminUserSupport } from './support';

const sessionTokensForUser = async (
  db: LobeChatDatabase,
  params: { excludeSessionId?: string; sessionIds?: string[]; userId: string },
): Promise<string[]> => {
  const conditions = [eq(session.userId, params.userId)];
  if (params.sessionIds && params.sessionIds.length > 0) {
    conditions.push(inArray(session.id, params.sessionIds));
  }
  if (params.excludeSessionId) {
    conditions.push(ne(session.id, params.excludeSessionId));
  }
  const rows = await db
    .select({ token: session.token })
    .from(session)
    .where(and(...conditions));
  return rows
    .map((row) => row.token)
    .filter((token): token is string => typeof token === 'string' && token.length > 0);
};

export class AdminUserSessionService extends AdminUserSupport {
  revokeSessions = async (params: {
    actorSessionId?: string | null;
    actorUserId: string;
    input: AdminUsersRevokeSessionsInput;
  }) => {
    const { actorUserId, actorSessionId, input } = params;

    // Not-found audit must persist even when mutation aborts (R2-03).
    const exists = await this.users.findBanState(input.userId);
    if (!exists) {
      await this.auditUserFailure({
        action: 'admin.users.revokeSessions',
        actorUserId,
        error: 'not_found',
        reason: input.reason,
        result: 'failure',
        targetId: input.userId,
      });
      throw new AdminUserNotFoundError();
    }

    // ── Targeted revoke: delete only the listed session rows (no epoch advance) ──
    if (input.sessionIds && input.sessionIds.length > 0) {
      const uniqueIds = [...new Set(input.sessionIds)];
      try {
        const { revokedCount, tokens } = await this.db.transaction(async (tx) => {
          const model = new AdminUserModel(tx);
          const belonging = await model.countSessionsBelongingToUser({
            sessionIds: uniqueIds,
            userId: input.userId,
          });
          if (belonging !== uniqueIds.length) {
            // Some ids are foreign/unknown — reject without leaking which.
            throw new InvalidRetainedSessionError('retained_session_invalid');
          }

          const tokens = await sessionTokensForUser(tx as LobeChatDatabase, {
            sessionIds: uniqueIds,
            userId: input.userId,
          });

          const count = await model.revokeSpecificSessions({
            sessionIds: uniqueIds,
            userId: input.userId,
          });

          await this.appendAuditInDb(tx, {
            action: 'admin.users.revokeSessions',
            actorUserId,
            afterDiff: { mode: 'targeted', requested: uniqueIds.length, revokedCount: count },
            reason: input.reason,
            result: 'success',
            targetId: input.userId,
            targetType: 'user',
          });

          return { revokedCount: count, tokens };
        });

        // Drop Redis after the DB commit so get-session cannot keep serving the token.
        await deleteBetterAuthSecondaryStorageSessions(tokens);

        // Targeted revoke keeps the user's other sessions alive — do not touch OIDC epoch.
        await this.publishUserSecurityInvalidation(input.userId);

        return { revokedCount, userId: input.userId };
      } catch (error) {
        if (error instanceof InvalidRetainedSessionError) {
          await this.auditUserFailure({
            action: 'admin.users.revokeSessions',
            actorUserId,
            error: error.reasonCode,
            extra: { mode: 'targeted', retainedSessionAttempt: true },
            reason: input.reason,
            result: 'denied',
            targetId: input.userId,
          });
          throw error;
        }
        throw error;
      }
    }

    /**
     * includeCurrent=false (actor===target with trusted sessionId):
     * delete other BA sessions, advance authInvalidatedAt, record retained
     * session id as cutoff exception. Never rewrites session.createdAt
     * (reauth clock unchanged). OIDC/API-key cannot use the exception.
     */
    const excludeSessionId =
      !input.includeCurrent && actorSessionId && input.userId === actorUserId
        ? actorSessionId
        : undefined;

    try {
      const { revokedCount, tokens } = await this.db.transaction(async (tx) => {
        const model = new AdminUserModel(tx);
        const cutoff = new Date();

        if (excludeSessionId) {
          const ok = await model.assertSessionBelongsToUser({
            sessionId: excludeSessionId,
            userId: input.userId,
          });
          if (!ok) {
            // Distinct internal error so outer path can audit without leaking ownership.
            throw new InvalidRetainedSessionError('retained_session_invalid');
          }
        }

        const tokens = await sessionTokensForUser(tx as LobeChatDatabase, {
          excludeSessionId,
          userId: input.userId,
        });

        const count = await model.revokeSessionsForUser({
          excludeSessionId,
          userId: input.userId,
        });

        // Full revoke (includeCurrent or no retainable session) clears exception.
        await model.invalidateAuth({
          at: cutoff,
          excludedSessionId: excludeSessionId ?? null,
          userId: input.userId,
        });

        await this.appendAuditInDb(tx, {
          action: 'admin.users.revokeSessions',
          actorUserId,
          afterDiff: {
            includeCurrent: Boolean(input.includeCurrent),
            preservedSession: Boolean(excludeSessionId),
            revokedCount: count,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        return { revokedCount: count, tokens };
      });

      await deleteBetterAuthSecondaryStorageSessions(tokens);

      try {
        await revokeOIDCArtifactsByUserId(this.db, input.userId);
      } catch {
        // best-effort; authInvalidatedAt already advanced
      }

      await this.publishUserSecurityInvalidation(input.userId);

      return { revokedCount, userId: input.userId };
    } catch (error) {
      if (error instanceof InvalidRetainedSessionError) {
        // Mutation rolled back; persist sanitized denial outside the txn (R3-03).
        await this.auditUserFailure({
          action: 'admin.users.revokeSessions',
          actorUserId,
          error: error.reasonCode,
          extra: {
            // Never log session tokens.
            retainedSessionAttempt: true,
          },
          reason: input.reason,
          result: 'denied',
          targetId: input.userId,
        });
        throw error;
      }
      throw error;
    }
  };
}
