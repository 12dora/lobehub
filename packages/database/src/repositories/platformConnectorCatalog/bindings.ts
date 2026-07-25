/**
 * User connector binding lifecycle aggregate (DB-005).
 */
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';

import type {
  NewPlatformConnectorOAuthState,
  NewPlatformUserConnectorBinding,
  PlatformConnectorOAuthStateItem,
  PlatformUserConnectorBindingItem,
} from '../../schemas/platform/connectors';
import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformUserConnectorBindings,
} from '../../schemas/platform/connectors';
import type { LobeChatDatabase, Transaction } from '../../type';
import { inTransaction } from '../platform/tx';
import { boundedLimit } from '../platformPagination';
import { lockManagedConnectorSecret, sqlIncrement } from './types';

export class PlatformUserConnectorBindingRepository {
  constructor(
    private readonly db: LobeChatDatabase | Transaction,
    private readonly userId: string,
  ) {}

  createOAuthState = async (
    values: Omit<
      NewPlatformConnectorOAuthState,
      'consumedAt' | 'createdAt' | 'revisionResourceType' | 'revokedAt' | 'userId'
    >,
  ): Promise<PlatformConnectorOAuthStateItem> => {
    return inTransaction(this.db, async (db) => {
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, values.connectorId))
        .limit(1)
        .for('update');
      if (!connector) throw new Error('PLATFORM_CONNECTOR_NOT_FOUND');
      await lockManagedConnectorSecret(db, {
        connectorId: values.connectorId,
        ref: values.pkceVerifierRef,
        slot: 'oauthPkceVerifier',
      });
      const owned = await db
        .select({ id: platformUserConnectorBindings.id })
        .from(platformUserConnectorBindings)
        .where(
          and(
            eq(platformUserConnectorBindings.id, values.bindingId),
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.connectorId, values.connectorId),
            inArray(platformUserConnectorBindings.status, [
              'connected',
              'error',
              'expired',
              'pending',
            ]),
            isNull(platformUserConnectorBindings.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!owned[0]) throw new Error('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
      const [row] = await db
        .insert(platformConnectorOAuthStates)
        .values({ ...values, userId: this.userId })
        .returning();
      return row;
    });
  };

  prepareOAuthAuthorization = async (params: {
    bindingId: string;
    connectorId: string;
    expiresAt: Date;
    pkceVerifierRef: string;
    publishedRevision: number;
    redirectUri: string;
    returnTo?: string;
    scopes: string[];
    stateHash: string;
    stateId: string;
  }): Promise<{
    binding: PlatformUserConnectorBindingItem;
    pkceVerifierRefs: string[];
  }> => {
    return inTransaction(this.db, async (db) => {
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(
          and(
            eq(platformConnectors.id, params.connectorId),
            eq(platformConnectors.credentialMode, 'per_user_oauth'),
            eq(platformConnectors.enabled, true),
            eq(platformConnectors.status, 'published'),
            eq(platformConnectors.publishedRevision, params.publishedRevision),
          ),
        )
        .limit(1)
        .for('update');
      if (!connector) throw new Error('PLATFORM_CONNECTOR_NOT_PUBLISHED');

      await lockManagedConnectorSecret(db, {
        connectorId: params.connectorId,
        ref: params.pkceVerifierRef,
        slot: 'oauthPkceVerifier',
      });

      await db
        .insert(platformUserConnectorBindings)
        .values({
          connectorId: params.connectorId,
          id: params.bindingId,
          publishedRevision: params.publishedRevision,
          status: 'pending',
          userId: this.userId,
        })
        .onConflictDoNothing({
          target: [platformUserConnectorBindings.userId, platformUserConnectorBindings.connectorId],
        });
      const [current] = await db
        .select()
        .from(platformUserConnectorBindings)
        .where(
          and(
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.connectorId, params.connectorId),
          ),
        )
        .limit(1)
        .for('update');
      if (!current) throw new Error('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');

      const preserveConnected = current.status === 'connected';
      const [binding] = await db
        .update(platformUserConnectorBindings)
        .set({
          ...(preserveConnected
            ? {}
            : {
                connectedAt: null,
                expiresAt: null,
                lastErrorCategory: null,
                oauthTokenRef: null,
                revokedAt: null,
                scopes: [],
                status: 'pending' as const,
                tokenFingerprint: null,
              }),
          publishedRevision: preserveConnected
            ? current.publishedRevision
            : params.publishedRevision,
          revision: sqlIncrement(platformUserConnectorBindings.revision),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(platformUserConnectorBindings.id, current.id),
            eq(platformUserConnectorBindings.userId, this.userId),
          ),
        )
        .returning();

      const previousStates = await db
        .select({
          id: platformConnectorOAuthStates.id,
          pkceVerifierRef: platformConnectorOAuthStates.pkceVerifierRef,
        })
        .from(platformConnectorOAuthStates)
        .where(
          and(
            eq(platformConnectorOAuthStates.bindingId, binding.id),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        )
        .for('update');
      const databaseNow = sql<Date>`CURRENT_TIMESTAMP`;
      await db
        .update(platformConnectorOAuthStates)
        .set({ consumedAt: null, revokedAt: databaseNow })
        .where(
          and(
            eq(platformConnectorOAuthStates.bindingId, binding.id),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        );
      await db.insert(platformConnectorOAuthStates).values({
        bindingId: binding.id,
        connectorId: params.connectorId,
        expiresAt: params.expiresAt,
        pkceVerifierRef: params.pkceVerifierRef,
        publishedRevision: params.publishedRevision,
        redirectUri: params.redirectUri,
        returnTo: params.returnTo,
        scopes: params.scopes,
        stateHash: params.stateHash,
        stateId: params.stateId,
        userId: this.userId,
      });
      return {
        binding,
        pkceVerifierRefs: previousStates.map((state) => state.pkceVerifierRef),
      };
    });
  };

  finalizeOAuthAuthorization = async (params: {
    connectedAt: Date;
    connectorId: string;
    expiresAt: Date | null;
    oauthTokenRef: string;
    publishedRevision: number;
    expectedBindingRevision: number;
    reservedAt: Date;
    scopes: string[];
    stateHash: string;
    tokenFingerprint: string;
  }): Promise<{
    binding: PlatformUserConnectorBindingItem;
    previousTokenRef: string | null;
  }> => {
    return inTransaction(this.db, async (db) => {
      const preview = await db.query.platformConnectorOAuthStates.findFirst({
        where: and(
          eq(platformConnectorOAuthStates.stateHash, params.stateHash),
          eq(platformConnectorOAuthStates.userId, this.userId),
          eq(platformConnectorOAuthStates.connectorId, params.connectorId),
        ),
      });
      if (!preview) throw new Error('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');

      // Global order: connector -> managed secret (when attaching) -> binding -> state.
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(
          and(
            eq(platformConnectors.id, params.connectorId),
            eq(platformConnectors.credentialMode, 'per_user_oauth'),
            eq(platformConnectors.enabled, true),
            eq(platformConnectors.status, 'published'),
            eq(platformConnectors.publishedRevision, params.publishedRevision),
          ),
        )
        .limit(1)
        .for('update');
      if (!connector) throw new Error('PLATFORM_CONNECTOR_NOT_PUBLISHED');
      await lockManagedConnectorSecret(db, {
        connectorId: params.connectorId,
        ref: params.oauthTokenRef,
        slot: 'oauthBindingToken',
      });
      const [current] = await db
        .select()
        .from(platformUserConnectorBindings)
        .where(
          and(
            eq(platformUserConnectorBindings.id, preview.bindingId),
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.connectorId, params.connectorId),
          ),
        )
        .limit(1)
        .for('update');
      if (
        !current ||
        current.revokedAt ||
        current.revision !== params.expectedBindingRevision ||
        !['connected', 'error', 'expired', 'pending'].includes(current.status)
      ) {
        throw new Error('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
      }
      const [state] = await db
        .select()
        .from(platformConnectorOAuthStates)
        .where(
          and(
            eq(platformConnectorOAuthStates.id, preview.id),
            eq(platformConnectorOAuthStates.stateHash, params.stateHash),
            eq(platformConnectorOAuthStates.userId, this.userId),
            eq(platformConnectorOAuthStates.connectorId, params.connectorId),
            eq(platformConnectorOAuthStates.publishedRevision, params.publishedRevision),
            eq(platformConnectorOAuthStates.consumedAt, params.reservedAt),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!state || state.bindingId !== current.id) {
        throw new Error('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
      }
      const [binding] = await db
        .update(platformUserConnectorBindings)
        .set({
          connectedAt: params.connectedAt,
          expiresAt: params.expiresAt,
          lastErrorCategory: null,
          oauthTokenRef: params.oauthTokenRef,
          publishedRevision: params.publishedRevision,
          revision: sqlIncrement(platformUserConnectorBindings.revision),
          revokedAt: null,
          scopes: params.scopes,
          status: 'connected',
          tokenFingerprint: params.tokenFingerprint,
          updatedAt: params.connectedAt,
        })
        .where(
          and(
            eq(platformUserConnectorBindings.id, current.id),
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.revision, params.expectedBindingRevision),
            isNull(platformUserConnectorBindings.revokedAt),
            inArray(platformUserConnectorBindings.status, [
              'connected',
              'error',
              'expired',
              'pending',
            ]),
          ),
        )
        .returning();
      if (!binding) throw new Error('PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH');
      const [completedState] = await db
        .update(platformConnectorOAuthStates)
        .set({
          authorizationOutcome: 'completed',
          finishedAt: params.connectedAt,
        })
        .where(
          and(
            eq(platformConnectorOAuthStates.id, state.id),
            eq(platformConnectorOAuthStates.consumedAt, params.reservedAt),
            isNull(platformConnectorOAuthStates.authorizationOutcome),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        )
        .returning({ id: platformConnectorOAuthStates.id });
      if (!completedState) throw new Error('PLATFORM_CONNECTOR_OAUTH_STATE_INVALID');
      return { binding, previousTokenRef: current.oauthTokenRef };
    });
  };

  getBinding = async (
    connectorId: string,
  ): Promise<PlatformUserConnectorBindingItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformUserConnectorBindings)
      .where(
        and(
          eq(platformUserConnectorBindings.userId, this.userId),
          eq(platformUserConnectorBindings.connectorId, connectorId),
        ),
      )
      .limit(1);
    return rows[0];
  };

  /**
   * Batch variant of {@link getBinding}: bindings for many connectors in ONE query
   * (`WHERE userId = :userId AND connectorId IN (:ids)`). Connectors without a binding
   * are simply absent from the map — callers use `.get(id)` and treat undefined as unbound.
   */
  getBindingsForConnectors = async (
    connectorIds: string[],
  ): Promise<Map<string, PlatformUserConnectorBindingItem>> => {
    const byConnectorId = new Map<string, PlatformUserConnectorBindingItem>();
    if (connectorIds.length === 0) return byConnectorId;
    const rows = await this.db
      .select()
      .from(platformUserConnectorBindings)
      .where(
        and(
          eq(platformUserConnectorBindings.userId, this.userId),
          inArray(platformUserConnectorBindings.connectorId, connectorIds),
        ),
      );
    for (const row of rows) {
      byConnectorId.set(row.connectorId, row);
    }
    return byConnectorId;
  };

  getAuthorizationAttempt = async (connectorId: string, attemptId: string) => {
    const [row] = await this.db
      .select({
        binding: platformUserConnectorBindings,
        state: platformConnectorOAuthStates,
      })
      .from(platformConnectorOAuthStates)
      .innerJoin(
        platformUserConnectorBindings,
        and(
          eq(platformUserConnectorBindings.id, platformConnectorOAuthStates.bindingId),
          eq(platformUserConnectorBindings.userId, platformConnectorOAuthStates.userId),
          eq(platformUserConnectorBindings.connectorId, platformConnectorOAuthStates.connectorId),
        ),
      )
      .where(
        and(
          eq(platformConnectorOAuthStates.stateId, attemptId),
          eq(platformConnectorOAuthStates.userId, this.userId),
          eq(platformConnectorOAuthStates.connectorId, connectorId),
        ),
      )
      .limit(1);
    return row;
  };

  listBindings = async (params: { cursor?: string; limit?: number }) => {
    const limit = boundedLimit(params.limit);
    const conditions = [eq(platformUserConnectorBindings.userId, this.userId)];
    if (params.cursor) conditions.push(gt(platformUserConnectorBindings.id, params.cursor));
    const rows = await this.db
      .select()
      .from(platformUserConnectorBindings)
      .where(and(...conditions))
      .orderBy(asc(platformUserConnectorBindings.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
  };

  revokeBindingWithPreviousSecret = async (
    connectorId: string,
  ): Promise<
    | {
        binding: PlatformUserConnectorBindingItem;
        pkceVerifierRefs: string[];
        previousTokenRef: string | null;
      }
    | undefined
  > => {
    return inTransaction(this.db, async (db) => {
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, connectorId))
        .limit(1)
        .for('update');
      if (!connector) return undefined;
      const owned = await db
        .select()
        .from(platformUserConnectorBindings)
        .where(
          and(
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.connectorId, connectorId),
            isNull(platformUserConnectorBindings.revokedAt),
          ),
        )
        .limit(1)
        .for('update');
      const current = owned[0];
      if (!current) return undefined;
      const bindingId = current.id;
      const databaseNow = sql<Date>`CURRENT_TIMESTAMP`;
      const states = await db
        .select({
          id: platformConnectorOAuthStates.id,
          pkceVerifierRef: platformConnectorOAuthStates.pkceVerifierRef,
        })
        .from(platformConnectorOAuthStates)
        .where(
          and(
            eq(platformConnectorOAuthStates.bindingId, bindingId),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        )
        .for('update');
      await db
        .update(platformConnectorOAuthStates)
        .set({ consumedAt: null, revokedAt: databaseNow })
        .where(
          and(
            eq(platformConnectorOAuthStates.bindingId, bindingId),
            isNull(platformConnectorOAuthStates.revokedAt),
          ),
        );
      const [row] = await db
        .update(platformUserConnectorBindings)
        .set({
          expiresAt: null,
          oauthTokenRef: null,
          revision: sqlIncrement(platformUserConnectorBindings.revision),
          revokedAt: databaseNow,
          scopes: [],
          status: 'revoked',
          tokenFingerprint: null,
          updatedAt: databaseNow,
        })
        .where(
          and(
            eq(platformUserConnectorBindings.id, bindingId),
            eq(platformUserConnectorBindings.userId, this.userId),
            isNull(platformUserConnectorBindings.revokedAt),
          ),
        )
        .returning();
      return {
        binding: row,
        pkceVerifierRefs: states.map((state) => state.pkceVerifierRef),
        previousTokenRef: current.oauthTokenRef,
      };
    });
  };

  updateBindingCas = async (
    connectorId: string,
    expectedRevision: number,
    values: Partial<
      Omit<
        NewPlatformUserConnectorBinding,
        'connectorId' | 'createdAt' | 'id' | 'revision' | 'userId'
      >
    >,
  ): Promise<PlatformUserConnectorBindingItem | undefined> => {
    return inTransaction(this.db, async (db) => {
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, connectorId))
        .limit(1)
        .for('update');
      if (!connector) return undefined;
      if (values.oauthTokenRef) {
        await lockManagedConnectorSecret(db, {
          connectorId,
          ref: values.oauthTokenRef,
          slot: 'oauthBindingToken',
        });
      }
      const [row] = await db
        .update(platformUserConnectorBindings)
        .set({ ...values, revision: expectedRevision + 1, updatedAt: new Date() })
        .where(
          and(
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.connectorId, connectorId),
            eq(platformUserConnectorBindings.revision, expectedRevision),
          ),
        )
        .returning();
      return row;
    });
  };

  upsertBinding = async (
    values: Omit<NewPlatformUserConnectorBinding, 'userId'>,
  ): Promise<PlatformUserConnectorBindingItem> => {
    return inTransaction(this.db, async (db) => {
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, values.connectorId))
        .limit(1)
        .for('update');
      if (!connector) throw new Error('PLATFORM_CONNECTOR_NOT_FOUND');
      if (values.oauthTokenRef) {
        await lockManagedConnectorSecret(db, {
          connectorId: values.connectorId,
          ref: values.oauthTokenRef,
          slot: 'oauthBindingToken',
        });
      }
      const [row] = await db
        .insert(platformUserConnectorBindings)
        .values({ ...values, userId: this.userId })
        .onConflictDoUpdate({
          set: {
            connectedAt: values.connectedAt,
            expiresAt: values.expiresAt,
            lastErrorCategory: values.lastErrorCategory,
            oauthTokenRef: values.oauthTokenRef,
            publishedRevision: values.publishedRevision,
            revision: sqlIncrement(platformUserConnectorBindings.revision),
            revokedAt: values.revokedAt,
            scopes: values.scopes,
            status: values.status,
            tokenFingerprint: values.tokenFingerprint,
            updatedAt: new Date(),
          },
          target: [platformUserConnectorBindings.userId, platformUserConnectorBindings.connectorId],
        })
        .returning();
      return row;
    });
  };
}
