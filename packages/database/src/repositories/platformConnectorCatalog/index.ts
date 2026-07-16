import { and, asc, eq, exists, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type {
  NewPlatformConnector,
  NewPlatformConnectorOAuthState,
  NewPlatformConnectorTool,
  NewPlatformUserConnectorBinding,
  PlatformConnectorItem,
  PlatformConnectorOAuthStateItem,
  PlatformConnectorToolItem,
  PlatformUserConnectorBindingItem,
} from '../../schemas/platform/connectors';
import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorTools,
  platformUserConnectorBindings,
} from '../../schemas/platform/connectors';
import type { PlatformResourceRevisionItem } from '../../schemas/platform/revisions';
import { platformResourceRevisions } from '../../schemas/platform/revisions';
import type { LobeChatDatabase, Transaction } from '../../type';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
export const MAX_PLATFORM_CONNECTOR_TOOLS = 1000;

const boundedLimit = (limit?: number): number =>
  Math.max(1, Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

const isRootDatabase = (db: LobeChatDatabase | Transaction): db is LobeChatDatabase =>
  'transaction' in db;

const inTransaction = async <T>(
  db: LobeChatDatabase | Transaction,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> => (isRootDatabase(db) ? db.transaction(operation) : operation(db));

export interface PlatformConnectorCursor {
  connectorKey: string;
  id: string;
}

export interface PlatformConnectorToolCursor {
  id: string;
  sort: number;
  toolKey: string;
}

export interface PlatformConnectorRevisionPayload extends Record<string, unknown> {
  connector: {
    credentialMode: PlatformConnectorItem['credentialMode'];
    description: string | null;
    displayName: string;
    enabled: boolean;
    endpoint: string;
    id: string;
    key: string;
    oauthClientSecretConfigured: boolean;
    oauthClientSecretFingerprint: string | null;
    oauthConfig: PlatformConnectorItem['oauthConfig'];
    sharedSecretConfigured: boolean;
    sharedSecretFingerprint: string | null;
    sort: number;
    transport: PlatformConnectorItem['transport'];
  };
  schemaVersion: 'm09-v1';
  tools: Array<
    Pick<
      PlatformConnectorToolItem,
      | 'description'
      | 'displayName'
      | 'inputSchema'
      | 'outputSchema'
      | 'platformPolicy'
      | 'requiresConfirmation'
      | 'riskLevel'
      | 'sort'
      | 'toolKey'
    >
  >;
}

export interface PlatformConnectorRuntimeRevision {
  payload: PlatformConnectorRevisionPayload;
  provenance: {
    checksum: string;
    connectorId: string;
    publishedAt: Date;
    revision: number;
    revisionId: string;
  };
}

export class PlatformConnectorCatalogRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  createConnector = async (values: NewPlatformConnector): Promise<PlatformConnectorItem> => {
    const [row] = await this.db.insert(platformConnectors).values(values).returning();
    return row;
  };

  createPublishedRevision = async (params: {
    checksum: string;
    connectorId: string;
    payload: PlatformConnectorRevisionPayload;
    publishedAt: Date;
    publishedBy: string;
    revision: number;
  }): Promise<PlatformResourceRevisionItem> => {
    const [row] = await this.db
      .insert(platformResourceRevisions)
      .values({
        checksum: params.checksum,
        payload: params.payload,
        publishedAt: params.publishedAt,
        publishedBy: params.publishedBy,
        resourceId: params.connectorId,
        resourceType: 'connector',
        revision: params.revision,
        status: 'published',
      })
      .returning();
    return row;
  };

  getConnector = async (id: string): Promise<PlatformConnectorItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformConnectors)
      .where(eq(platformConnectors.id, id))
      .limit(1);
    return rows[0];
  };

  getConnectorByKey = async (connectorKey: string): Promise<PlatformConnectorItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformConnectors)
      .where(eq(platformConnectors.connectorKey, connectorKey))
      .limit(1);
    return rows[0];
  };

  getCurrentPublishedRuntime = async (
    connectorId: string,
  ): Promise<PlatformConnectorRuntimeRevision | undefined> => {
    const rows = await this.db
      .select({
        checksum: platformResourceRevisions.checksum,
        connectorId: platformConnectors.id,
        payload: platformResourceRevisions.payload,
        publishedAt: platformResourceRevisions.publishedAt,
        revision: platformResourceRevisions.revision,
        revisionId: platformResourceRevisions.id,
      })
      .from(platformConnectors)
      .innerJoin(
        platformResourceRevisions,
        and(
          eq(platformResourceRevisions.resourceType, 'connector'),
          eq(platformResourceRevisions.resourceId, platformConnectors.id),
          eq(platformResourceRevisions.revision, platformConnectors.publishedRevision),
          eq(platformResourceRevisions.checksum, platformConnectors.publishedChecksum),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .where(eq(platformConnectors.id, connectorId))
      .limit(1);
    const row = rows[0];
    if (!row?.publishedAt) return undefined;
    return {
      payload: row.payload as unknown as PlatformConnectorRevisionPayload,
      provenance: {
        checksum: row.checksum,
        connectorId: row.connectorId,
        publishedAt: row.publishedAt,
        revision: row.revision,
        revisionId: row.revisionId,
      },
    };
  };

  getPublishedRuntimeRevision = async (
    connectorId: string,
    revision: number,
  ): Promise<PlatformConnectorRuntimeRevision | undefined> => {
    const rows = await this.db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'connector'),
          eq(platformResourceRevisions.resourceId, connectorId),
          eq(platformResourceRevisions.revision, revision),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.publishedAt) return undefined;
    return {
      payload: row.payload as unknown as PlatformConnectorRevisionPayload,
      provenance: {
        checksum: row.checksum,
        connectorId,
        publishedAt: row.publishedAt,
        revision: row.revision,
        revisionId: row.id,
      },
    };
  };

  listConnectors = async (params: {
    credentialMode?: PlatformConnectorItem['credentialMode'];
    cursor?: PlatformConnectorCursor | string;
    enabled?: boolean;
    limit?: number;
    query?: string;
    status?: PlatformConnectorItem['status'];
  }) => {
    const limit = boundedLimit(params.limit);
    const cursor = params.cursor;
    const conditions = [
      ...(params.credentialMode
        ? [eq(platformConnectors.credentialMode, params.credentialMode)]
        : []),
      ...(params.enabled === undefined ? [] : [eq(platformConnectors.enabled, params.enabled)]),
      ...(params.status ? [eq(platformConnectors.status, params.status)] : []),
      ...(params.query
        ? [
            or(
              ilike(platformConnectors.connectorKey, `%${escapeLike(params.query)}%`),
              ilike(platformConnectors.displayName, `%${escapeLike(params.query)}%`),
            )!,
          ]
        : []),
    ];
    if (typeof cursor === 'string') {
      conditions.push(gt(platformConnectors.connectorKey, cursor));
    } else if (cursor) {
      conditions.push(
        or(
          gt(platformConnectors.connectorKey, cursor.connectorKey),
          and(
            eq(platformConnectors.connectorKey, cursor.connectorKey),
            gt(platformConnectors.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(platformConnectors)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(platformConnectors.connectorKey), asc(platformConnectors.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? { connectorKey: last.connectorKey, id: last.id } : null,
    };
  };

  listTools = async (params: {
    connectorId: string;
    cursor?: PlatformConnectorToolCursor;
    limit?: number;
  }) => {
    const limit = boundedLimit(params.limit);
    const cursor = params.cursor;
    const conditions = [eq(platformConnectorTools.connectorId, params.connectorId)];
    if (cursor) {
      conditions.push(
        or(
          gt(platformConnectorTools.sort, cursor.sort),
          and(
            eq(platformConnectorTools.sort, cursor.sort),
            gt(platformConnectorTools.toolKey, cursor.toolKey),
          ),
          and(
            eq(platformConnectorTools.sort, cursor.sort),
            eq(platformConnectorTools.toolKey, cursor.toolKey),
            gt(platformConnectorTools.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(platformConnectorTools)
      .where(and(...conditions))
      .orderBy(
        asc(platformConnectorTools.sort),
        asc(platformConnectorTools.toolKey),
        asc(platformConnectorTools.id),
      )
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? { id: last.id, sort: last.sort, toolKey: last.toolKey } : null,
    };
  };

  replaceTools = async (
    connectorId: string,
    tools: Array<Omit<NewPlatformConnectorTool, 'connectorId'>>,
  ): Promise<PlatformConnectorToolItem[]> => {
    if (tools.length > MAX_PLATFORM_CONNECTOR_TOOLS) {
      throw new Error('PLATFORM_CONNECTOR_TOOL_LIMIT_EXCEEDED');
    }
    const replace = async (db: LobeChatDatabase | Transaction) => {
      const locked = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, connectorId))
        .limit(1)
        .for('update');
      if (!locked[0]) throw new Error('PLATFORM_CONNECTOR_NOT_FOUND');
      await db
        .delete(platformConnectorTools)
        .where(eq(platformConnectorTools.connectorId, connectorId));
      if (tools.length === 0) return [];
      return db
        .insert(platformConnectorTools)
        .values(tools.map((tool) => ({ ...tool, connectorId })))
        .returning();
    };
    return inTransaction(this.db, replace);
  };

  setPublishedPointerCas = async (params: {
    checksum: string;
    connectorId: string;
    expectedRevision: number;
    publishedAt: Date;
    publishedRevision: number;
  }): Promise<PlatformConnectorItem | undefined> => {
    const [row] = await this.db
      .update(platformConnectors)
      .set({
        publishedAt: params.publishedAt,
        publishedChecksum: params.checksum,
        publishedRevision: params.publishedRevision,
        revision: params.expectedRevision + 1,
        status: 'published',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformConnectors.id, params.connectorId),
          eq(platformConnectors.revision, params.expectedRevision),
        ),
      )
      .returning();
    return row;
  };

  updateConnectorDraftCas = async (
    id: string,
    expectedRevision: number,
    values: Partial<
      Omit<
        NewPlatformConnector,
        'createdAt' | 'id' | 'publishedAt' | 'publishedChecksum' | 'publishedRevision' | 'revision'
      >
    >,
  ): Promise<PlatformConnectorItem | undefined> => {
    const [row] = await this.db
      .update(platformConnectors)
      .set({
        ...values,
        revision: expectedRevision + 1,
        status: 'draft',
        updatedAt: new Date(),
      })
      .where(and(eq(platformConnectors.id, id), eq(platformConnectors.revision, expectedRevision)))
      .returning();
    return row;
  };

  consumeOAuthState = async (
    stateHash: string,
  ): Promise<PlatformConnectorOAuthStateItem | undefined> => {
    const databaseNow = sql<Date>`CURRENT_TIMESTAMP`;
    const validBinding = this.db
      .select({ id: platformUserConnectorBindings.id })
      .from(platformUserConnectorBindings)
      .where(
        and(
          eq(platformUserConnectorBindings.id, platformConnectorOAuthStates.bindingId),
          eq(platformUserConnectorBindings.userId, platformConnectorOAuthStates.userId),
          eq(platformUserConnectorBindings.connectorId, platformConnectorOAuthStates.connectorId),
          eq(
            platformUserConnectorBindings.publishedRevision,
            platformConnectorOAuthStates.publishedRevision,
          ),
          inArray(platformUserConnectorBindings.status, [
            'connected',
            'error',
            'expired',
            'pending',
          ]),
          isNull(platformUserConnectorBindings.revokedAt),
        ),
      )
      .for('update');
    const [row] = await this.db
      .update(platformConnectorOAuthStates)
      .set({ consumedAt: databaseNow })
      .where(
        and(
          eq(platformConnectorOAuthStates.stateHash, stateHash),
          isNull(platformConnectorOAuthStates.consumedAt),
          isNull(platformConnectorOAuthStates.revokedAt),
          lte(platformConnectorOAuthStates.createdAt, databaseNow),
          gt(platformConnectorOAuthStates.expiresAt, databaseNow),
          exists(validBinding),
        ),
      )
      .returning();
    return row;
  };

  revokeAllBindingsPage = async (params: {
    afterId?: string;
    connectorId: string;
    limit?: number;
  }) => {
    return inTransaction(this.db, async (db) => {
      const limit = boundedLimit(params.limit);
      const conditions = [
        eq(platformUserConnectorBindings.connectorId, params.connectorId),
        isNull(platformUserConnectorBindings.revokedAt),
      ];
      if (params.afterId) conditions.push(gt(platformUserConnectorBindings.id, params.afterId));
      const rows = await db
        .select({ id: platformUserConnectorBindings.id })
        .from(platformUserConnectorBindings)
        .where(and(...conditions))
        .orderBy(asc(platformUserConnectorBindings.id))
        .limit(limit + 1)
        .for('update');
      const hasMore = rows.length > limit;
      const ids = (hasMore ? rows.slice(0, limit) : rows).map((row) => row.id);
      let revoked = 0;
      if (ids.length > 0) {
        const databaseNow = sql<Date>`CURRENT_TIMESTAMP`;
        await db
          .update(platformConnectorOAuthStates)
          .set({ revokedAt: databaseNow })
          .where(
            and(
              inArray(platformConnectorOAuthStates.bindingId, ids),
              isNull(platformConnectorOAuthStates.consumedAt),
              isNull(platformConnectorOAuthStates.revokedAt),
            ),
          );
        const updated = await db
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
              eq(platformUserConnectorBindings.connectorId, params.connectorId),
              inArray(platformUserConnectorBindings.id, ids),
              isNull(platformUserConnectorBindings.revokedAt),
            ),
          )
          .returning({ id: platformUserConnectorBindings.id });
        revoked = updated.length;
      }
      return {
        nextCursor: hasMore ? (ids.at(-1) ?? null) : null,
        revoked,
      };
    });
  };
}

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
      const owned = await db
        .select({ id: platformUserConnectorBindings.id })
        .from(platformUserConnectorBindings)
        .where(
          and(
            eq(platformUserConnectorBindings.id, values.bindingId),
            eq(platformUserConnectorBindings.userId, this.userId),
            eq(platformUserConnectorBindings.connectorId, values.connectorId),
            eq(platformUserConnectorBindings.publishedRevision, values.publishedRevision),
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

  revokeBinding = async (
    connectorId: string,
  ): Promise<PlatformUserConnectorBindingItem | undefined> => {
    return inTransaction(this.db, async (db) => {
      const owned = await db
        .select({ id: platformUserConnectorBindings.id })
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
      const bindingId = owned[0]?.id;
      if (!bindingId) return undefined;
      const databaseNow = sql<Date>`CURRENT_TIMESTAMP`;
      await db
        .update(platformConnectorOAuthStates)
        .set({ revokedAt: databaseNow })
        .where(
          and(
            eq(platformConnectorOAuthStates.bindingId, bindingId),
            isNull(platformConnectorOAuthStates.consumedAt),
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
      return row;
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
    const [row] = await this.db
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
  };

  upsertBinding = async (
    values: Omit<NewPlatformUserConnectorBinding, 'userId'>,
  ): Promise<PlatformUserConnectorBindingItem> => {
    const [row] = await this.db
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
  };
}

const sqlIncrement = (column: typeof platformUserConnectorBindings.revision) => sql`${column} + 1`;

const escapeLike = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
