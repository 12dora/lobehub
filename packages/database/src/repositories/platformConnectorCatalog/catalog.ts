/**
 * Connector catalog / revision / tools aggregate (DB-005).
 */
import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';

import type {
  PlatformConnectorItem,
  PlatformConnectorToolItem,
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
import { inTransaction } from '../platform/tx';
import { boundedLimit } from '../platformPagination';
import { likeContains } from '../platformSearch';
import { PlatformConnectorOAuthStateRepository } from './oauthState';
import type {
  ManagedConnectorCreate,
  ManagedConnectorSecretColumns,
  ManagedConnectorToolWrite,
  PlatformConnectorCursor,
  PlatformConnectorExactReference,
  PlatformConnectorExactRuntimeRevision,
  PlatformConnectorRevisionPayload,
  PlatformConnectorRuntimeRevision,
  PlatformConnectorToolCursor,
} from './types';
import { MAX_PLATFORM_CONNECTOR_TOOLS, sqlIncrement } from './types';

/**
 * Catalog + OAuth reservation facade. OAuth CAS lives in
 * {@link PlatformConnectorOAuthStateRepository}; this class extends it so existing
 * `catalog.reserveOAuthState(...)` call sites stay type-compatible (DB-005).
 */
export class PlatformConnectorCatalogRepository extends PlatformConnectorOAuthStateRepository {
  createConnector = async (values: ManagedConnectorCreate): Promise<PlatformConnectorItem> => {
    const [row] = await this.db
      .insert(platformConnectors)
      .values({
        ...values,
        legacyConnectionType: 'http',
        legacyIsRequired: false,
        legacyMcpServerUrl: values.endpoint,
        legacyName: values.displayName,
        legacySourceType: 'custom',
        migrationRequired: false,
      })
      .returning();
    return row;
  };

  initializeConnectorDraftSecrets = async (
    connectorId: string,
    values: ManagedConnectorSecretColumns,
  ): Promise<PlatformConnectorItem | undefined> => {
    const [row] = await this.db
      .update(platformConnectors)
      .set(values)
      .where(
        and(
          eq(platformConnectors.id, connectorId),
          eq(platformConnectors.revision, 0),
          eq(platformConnectors.status, 'draft'),
          isNull(platformConnectors.oauthClientSecretRef),
          isNull(platformConnectors.sharedSecretRef),
        ),
      )
      .returning();
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

  /** Batch connector rows by id (single `WHERE id IN (...)`). */
  getConnectorsByIds = async (ids: string[]): Promise<PlatformConnectorItem[]> => {
    if (ids.length === 0) return [];
    return this.db.select().from(platformConnectors).where(inArray(platformConnectors.id, ids));
  };

  getConnectorByKey = async (connectorKey: string): Promise<PlatformConnectorItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformConnectors)
      .where(
        and(
          eq(platformConnectors.connectorKey, connectorKey),
          eq(platformConnectors.migrationRequired, false),
        ),
      )
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
      .where(
        and(
          eq(platformConnectors.id, connectorId),
          eq(platformConnectors.migrationRequired, false),
        ),
      )
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

  /**
   * Batch variant of {@link getCurrentPublishedRuntime}: resolves the current published runtime
   * revision for many connectors in ONE query (`WHERE id IN (:ids)`). Ids without a current
   * published pointer are simply absent from the result — the caller maps them to `null`.
   */
  getCurrentPublishedRuntimeBatch = async (
    connectorIds: string[],
  ): Promise<PlatformConnectorRuntimeRevision[]> => {
    if (connectorIds.length === 0) return [];
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
      .where(
        and(
          inArray(platformConnectors.id, connectorIds),
          eq(platformConnectors.migrationRequired, false),
        ),
      );
    return rows
      .filter((row) => row.publishedAt)
      .map((row) => ({
        payload: row.payload as unknown as PlatformConnectorRevisionPayload,
        provenance: {
          checksum: row.checksum,
          connectorId: row.connectorId,
          publishedAt: row.publishedAt!,
          revision: row.revision,
          revisionId: row.revisionId,
        },
      }));
  };

  getPublishedRuntimeRevision = async (
    connectorId: string,
    revision: number,
  ): Promise<PlatformConnectorRuntimeRevision | undefined> => {
    const [managed] = await this.db
      .select({ id: platformConnectors.id })
      .from(platformConnectors)
      .where(
        and(
          eq(platformConnectors.id, connectorId),
          eq(platformConnectors.migrationRequired, false),
        ),
      )
      .limit(1);
    if (!managed) return undefined;
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

  /**
   * Resolve exact historical runtime revisions for many Connectors in one query. Validation may
   * carry up to 100 refs and must remain a constant-roundtrip operation.
   */
  getPublishedRuntimeRevisionsExact = async (
    references: readonly PlatformConnectorExactReference[],
  ): Promise<Map<string, PlatformConnectorExactRuntimeRevision>> => {
    if (references.length === 0) return new Map();
    const requestedPairs = references.map(({ connectorId, publishedRevision }) =>
      and(
        eq(platformConnectors.id, connectorId),
        eq(platformResourceRevisions.revision, publishedRevision),
      ),
    );
    const rows = await this.db
      .select({
        checksum: platformResourceRevisions.checksum,
        connectorId: platformConnectors.id,
        connectorKey: platformConnectors.connectorKey,
        connectorStatus: platformConnectors.status,
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
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .where(and(eq(platformConnectors.migrationRequired, false), or(...requestedPairs)));

    const exact = new Map<string, PlatformConnectorExactRuntimeRevision>();
    for (const row of rows) {
      if (!row.publishedAt) continue;
      exact.set(`${row.connectorId}\0${row.revision}`, {
        connector: {
          connectorKey: row.connectorKey,
          id: row.connectorId,
          status: row.connectorStatus,
        },
        payload: row.payload as unknown as PlatformConnectorRevisionPayload,
        provenance: {
          checksum: row.checksum,
          connectorId: row.connectorId,
          publishedAt: row.publishedAt,
          revision: row.revision,
          revisionId: row.revisionId,
        },
      });
    }
    return exact;
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
      eq(platformConnectors.migrationRequired, false),
      ...(params.credentialMode
        ? [eq(platformConnectors.credentialMode, params.credentialMode)]
        : []),
      ...(params.enabled === undefined ? [] : [eq(platformConnectors.enabled, params.enabled)]),
      ...(params.status ? [eq(platformConnectors.status, params.status)] : []),
      ...(params.query
        ? [
            or(
              ilike(platformConnectors.connectorKey, likeContains(params.query)),
              ilike(platformConnectors.displayName, likeContains(params.query)),
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

  /**
   * All tools for many connectors in one query. Caller enforces per-connector
   * max tool count; empty input short-circuits.
   */
  listToolsForConnectors = async (connectorIds: string[]): Promise<PlatformConnectorToolItem[]> => {
    if (connectorIds.length === 0) return [];
    return this.db
      .select()
      .from(platformConnectorTools)
      .where(inArray(platformConnectorTools.connectorId, connectorIds))
      .orderBy(
        asc(platformConnectorTools.connectorId),
        asc(platformConnectorTools.sort),
        asc(platformConnectorTools.toolKey),
        asc(platformConnectorTools.id),
      );
  };

  replaceTools = async (
    connectorId: string,
    tools: ManagedConnectorToolWrite[],
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
        .values(
          tools.map((tool) => ({
            ...tool,
            connectorId,
            legacyAllowUserStricterPolicy: true,
            legacyManifest: {
              description: tool.description ?? undefined,
              inputSchema: tool.inputSchema,
              name: tool.toolKey,
              outputSchema: tool.outputSchema,
            },
            legacyPermissionPolicy: 'needs_approval',
          })),
        )
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
          eq(platformConnectors.migrationRequired, false),
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
        ManagedConnectorCreate,
        'createdAt' | 'id' | 'publishedAt' | 'publishedChecksum' | 'publishedRevision' | 'revision'
      >
    >,
  ): Promise<PlatformConnectorItem | undefined> => {
    const [row] = await this.db
      .update(platformConnectors)
      .set({
        ...values,
        ...(values.displayName === undefined ? {} : { legacyName: values.displayName }),
        ...(values.endpoint === undefined ? {} : { legacyMcpServerUrl: values.endpoint }),
        revision: expectedRevision + 1,
        status: 'draft',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformConnectors.id, id),
          eq(platformConnectors.revision, expectedRevision),
          eq(platformConnectors.migrationRequired, false),
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
      const [connector] = await db
        .select({ id: platformConnectors.id })
        .from(platformConnectors)
        .where(eq(platformConnectors.id, params.connectorId))
        .limit(1)
        .for('update');
      if (!connector) {
        return { nextCursor: null, pkceVerifierRefs: [], revoked: 0, tokenRefs: [] };
      }
      const conditions = [
        eq(platformUserConnectorBindings.connectorId, params.connectorId),
        isNull(platformUserConnectorBindings.revokedAt),
      ];
      if (params.afterId) conditions.push(gt(platformUserConnectorBindings.id, params.afterId));
      const rows = await db
        .select({
          id: platformUserConnectorBindings.id,
          oauthTokenRef: platformUserConnectorBindings.oauthTokenRef,
        })
        .from(platformUserConnectorBindings)
        .where(and(...conditions))
        .orderBy(asc(platformUserConnectorBindings.id))
        .limit(limit + 1)
        .for('update');
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const ids = page.map((row) => row.id);
      let revoked = 0;
      const pkceVerifierRefs: string[] = [];
      const tokenRefs = page
        .map((row) => row.oauthTokenRef)
        .filter((ref): ref is string => ref !== null);
      if (ids.length > 0) {
        const databaseNow = sql<Date>`CURRENT_TIMESTAMP`;
        const states = await db
          .select({
            id: platformConnectorOAuthStates.id,
            pkceVerifierRef: platformConnectorOAuthStates.pkceVerifierRef,
          })
          .from(platformConnectorOAuthStates)
          .where(
            and(
              inArray(platformConnectorOAuthStates.bindingId, ids),
              isNull(platformConnectorOAuthStates.revokedAt),
            ),
          )
          .for('update');
        pkceVerifierRefs.push(...states.map((state) => state.pkceVerifierRef));
        await db
          .update(platformConnectorOAuthStates)
          .set({ consumedAt: null, revokedAt: databaseNow })
          .where(
            and(
              inArray(platformConnectorOAuthStates.bindingId, ids),
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
        pkceVerifierRefs,
        revoked,
        tokenRefs,
      };
    });
  };
}
