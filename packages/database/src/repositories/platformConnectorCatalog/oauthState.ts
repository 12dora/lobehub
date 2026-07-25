/**
 * Connector OAuth state reservation aggregate (DB-005).
 * Isolated so OAuth CAS/locking cannot drift from catalog draft methods.
 */
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import type { PlatformConnectorOAuthStateItem } from '../../schemas/platform/connectors';
import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformUserConnectorBindings,
} from '../../schemas/platform/connectors';
import type { LobeChatDatabase, Transaction } from '../../type';
import { inTransaction } from '../platform/tx';
import type { OAuthStateReservationResult } from './types';
// Re-import tables used by reserve — already in imports_only via original file

export class PlatformConnectorOAuthStateRepository {
  constructor(protected readonly db: LobeChatDatabase | Transaction) {}

  reserveOAuthState = async (stateHash: string): Promise<OAuthStateReservationResult> => {
    return inTransaction(this.db, async (db) => {
      const preview = await db.query.platformConnectorOAuthStates.findFirst({
        where: eq(platformConnectorOAuthStates.stateHash, stateHash),
      });
      if (!preview) return { status: 'invalid' };

      // Global order: connector -> managed secret (when attaching) -> binding -> state.
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, preview.connectorId))
        .limit(1)
        .for('update');
      if (!connector) return { status: 'invalid' };
      const [binding] = await db
        .select({
          id: platformUserConnectorBindings.id,
          revision: platformUserConnectorBindings.revision,
          revokedAt: platformUserConnectorBindings.revokedAt,
          status: platformUserConnectorBindings.status,
        })
        .from(platformUserConnectorBindings)
        .where(
          and(
            eq(platformUserConnectorBindings.id, preview.bindingId),
            eq(platformUserConnectorBindings.userId, preview.userId),
            eq(platformUserConnectorBindings.connectorId, preview.connectorId),
          ),
        )
        .limit(1)
        .for('update');
      const [state] = await db
        .select()
        .from(platformConnectorOAuthStates)
        .where(
          and(
            eq(platformConnectorOAuthStates.id, preview.id),
            eq(platformConnectorOAuthStates.stateHash, stateHash),
          ),
        )
        .limit(1)
        .for('update');
      if (!state || state.revokedAt || !binding || binding.revokedAt) return { status: 'invalid' };
      if (state.consumedAt) return { status: 'replayed' };
      if (!['connected', 'error', 'expired', 'pending'].includes(binding.status)) {
        return { status: 'invalid' };
      }
      // PostgreSQL timestamps carry microseconds while JS Date only carries milliseconds.
      // Normalize at reservation time so the release/terminate CAS round-trips exactly.
      const databaseNow = sql<Date>`date_trunc('milliseconds', CURRENT_TIMESTAMP)`;
      const [row] = await db
        .update(platformConnectorOAuthStates)
        .set({ consumedAt: databaseNow })
        .where(
          and(
            eq(platformConnectorOAuthStates.id, state.id),
            isNull(platformConnectorOAuthStates.consumedAt),
            isNull(platformConnectorOAuthStates.revokedAt),
            lte(platformConnectorOAuthStates.createdAt, databaseNow),
            gt(platformConnectorOAuthStates.expiresAt, databaseNow),
          ),
        )
        .returning();
      if (row?.consumedAt) {
        return {
          bindingRevision: binding.revision,
          reservedAt: row.consumedAt,
          state: row,
          status: 'reserved',
        };
      }
      const [expired] = await db
        .update(platformConnectorOAuthStates)
        .set({ consumedAt: null, revokedAt: databaseNow })
        .where(
          and(
            eq(platformConnectorOAuthStates.id, state.id),
            lte(platformConnectorOAuthStates.expiresAt, databaseNow),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        )
        .returning({ connectorId: platformConnectorOAuthStates.connectorId });
      return expired
        ? {
            connectorId: expired.connectorId,
            pkceVerifierRefs: [state.pkceVerifierRef],
            status: 'expired',
          }
        : { status: 'invalid' };
    });
  };

  releaseOAuthStateReservation = async (stateHash: string, reservedAt: Date): Promise<boolean> => {
    const [row] = await this.db
      .update(platformConnectorOAuthStates)
      .set({ consumedAt: null })
      .where(
        and(
          eq(platformConnectorOAuthStates.stateHash, stateHash),
          eq(platformConnectorOAuthStates.consumedAt, reservedAt),
          isNull(platformConnectorOAuthStates.revokedAt),
        ),
      )
      .returning({ id: platformConnectorOAuthStates.id });
    return row !== undefined;
  };

  failOAuthStateReservation = async (
    stateHash: string,
    reservedAt: Date,
    finishedAt: Date,
  ): Promise<boolean> => {
    const [row] = await this.db
      .update(platformConnectorOAuthStates)
      .set({ authorizationOutcome: 'failed', finishedAt })
      .where(
        and(
          eq(platformConnectorOAuthStates.stateHash, stateHash),
          eq(platformConnectorOAuthStates.consumedAt, reservedAt),
          isNull(platformConnectorOAuthStates.authorizationOutcome),
          isNull(platformConnectorOAuthStates.revokedAt),
        ),
      )
      .returning({ id: platformConnectorOAuthStates.id });
    return row !== undefined;
  };

  terminateOAuthStateReservation = async (
    stateHash: string,
    reservedAt: Date,
  ): Promise<PlatformConnectorOAuthStateItem | undefined> => {
    const [row] = await this.db
      .update(platformConnectorOAuthStates)
      .set({ consumedAt: null, revokedAt: sql<Date>`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(platformConnectorOAuthStates.stateHash, stateHash),
          eq(platformConnectorOAuthStates.consumedAt, reservedAt),
          isNull(platformConnectorOAuthStates.revokedAt),
        ),
      )
      .returning();
    return row;
  };
}
