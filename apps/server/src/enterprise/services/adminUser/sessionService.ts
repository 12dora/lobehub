/**
 * Admin user session retention and revocation.
 */
import { AdminUserModel } from '@/database/models/adminUser';
import { revokeOIDCArtifactsByUserId } from '@/libs/oidc-provider/access-control';

import type { AdminUsersRevokeSessionsInput } from '../../contracts/adminUsers';
import { AdminUserNotFoundError, InvalidRetainedSessionError } from './errors';
import { AdminUserSupport } from './support';

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

          const { revokedCount, tokens } = await model.revokeAuthSessions({
            sessionIds: uniqueIds,
            userId: input.userId,
          });

          await this.appendAuditInDb(tx, {
            action: 'admin.users.revokeSessions',
            actorUserId,
            afterDiff: { mode: 'targeted', requested: uniqueIds.length, revokedCount },
            reason: input.reason,
            result: 'success',
            targetId: input.userId,
            targetType: 'user',
          });

          return { revokedCount, tokens };
        });

        // Drop Redis after the DB commit so get-session cannot keep serving the token.
        await this.evictBetterAuthSecondaryStorage(tokens);

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

        const { revokedCount, tokens } = await model.revokeAuthSessions({
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
            revokedCount,
          },
          reason: input.reason,
          result: 'success',
          targetId: input.userId,
          targetType: 'user',
        });

        return { revokedCount, tokens };
      });

      await this.evictBetterAuthSecondaryStorage(tokens);

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
