import { and, asc, eq, gt, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type {
  NewPlatformConnector,
  NewPlatformConnectorOAuthState,
  NewPlatformConnectorTool,
  NewPlatformUserConnectorBinding,
  PlatformConnectorItem,
  PlatformConnectorOAuthStateItem,
  PlatformConnectorSecretSlot,
  PlatformConnectorToolItem,
  PlatformUserConnectorBindingItem,
} from '../../schemas/platform/connectors';
import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformConnectorTools,
  platformUserConnectorBindings,
} from '../../schemas/platform/connectors';
import type { PlatformResourceRevisionItem } from '../../schemas/platform/revisions';
import { platformResourceRevisions } from '../../schemas/platform/revisions';
import type { LobeChatDatabase, Transaction } from '../../type';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
export const MAX_PLATFORM_CONNECTOR_TOOLS = 1000;

type ManagedConnectorCreate = Omit<
  NewPlatformConnector,
  | 'legacyConnectionType'
  | 'legacyEncryptedSharedCredentials'
  | 'legacyIsRequired'
  | 'legacyMcpServerUrl'
  | 'legacyMcpStdioConfig'
  | 'legacyName'
  | 'legacyOidcConfig'
  | 'legacySecretFingerprint'
  | 'legacySourceType'
  | 'endpoint'
> & { endpoint: string };

type ManagedConnectorToolWrite = Omit<
  NewPlatformConnectorTool,
  | 'connectorId'
  | 'legacyAllowUserStricterPolicy'
  | 'legacyLimitConfig'
  | 'legacyManifest'
  | 'legacyPermissionPolicy'
>;

type ManagedConnectorSecretColumns = Pick<
  ManagedConnectorCreate,
  | 'oauthClientSecretFingerprint'
  | 'oauthClientSecretRef'
  | 'oauthClientSecretUpdatedAt'
  | 'sharedSecretFingerprint'
  | 'sharedSecretRef'
  | 'sharedSecretUpdatedAt'
>;

const boundedLimit = (limit?: number): number =>
  Math.max(1, Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));

const isRootDatabase = (db: LobeChatDatabase | Transaction): db is LobeChatDatabase =>
  'transaction' in db;

const inTransaction = async <T>(
  db: LobeChatDatabase | Transaction,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> => (isRootDatabase(db) ? db.transaction(operation) : operation(db));

const MANAGED_CONNECTOR_SECRET_REF_PREFIX = 'kms://platform-connectors/';

const lockManagedConnectorSecret = async (
  db: Transaction,
  params: { connectorId: string; ref: string; slot: PlatformConnectorSecretSlot },
): Promise<void> => {
  if (!params.ref.startsWith(MANAGED_CONNECTOR_SECRET_REF_PREFIX)) return;
  const [secret] = await db
    .select({ id: platformConnectorSecrets.id })
    .from(platformConnectorSecrets)
    .where(
      and(
        eq(platformConnectorSecrets.connectorId, params.connectorId),
        eq(platformConnectorSecrets.ref, params.ref),
        eq(platformConnectorSecrets.slot, params.slot),
        isNull(platformConnectorSecrets.revokedAt),
      ),
    )
    .limit(1)
    .for('update');
  if (!secret) throw new Error('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
};

export interface PlatformConnectorCursor {
  connectorKey: string;
  id: string;
}

export interface PlatformConnectorToolCursor {
  id: string;
  sort: number;
  toolKey: string;
}

export type OAuthStateReservationResult =
  | {
      bindingRevision: number;
      reservedAt: Date;
      state: PlatformConnectorOAuthStateItem;
      status: 'reserved';
    }
  | { connectorId: string; pkceVerifierRefs: string[]; status: 'expired' }
  | { status: 'invalid' | 'replayed' };

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

export interface PlatformConnectorExactReference {
  connectorId: string;
  publishedRevision: number;
}

export interface PlatformConnectorExactRuntimeRevision extends PlatformConnectorRuntimeRevision {
  connector: Pick<PlatformConnectorItem, 'connectorKey' | 'id' | 'status'>;
}

export class PlatformConnectorCatalogRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

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

  consumeOAuthState = async (
    stateHash: string,
  ): Promise<PlatformConnectorOAuthStateItem | undefined> => {
    const reservation = await this.reserveOAuthState(stateHash);
    return reservation.status === 'reserved' ? reservation.state : undefined;
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
      const ids = (hasMore ? rows.slice(0, limit) : rows).map((row) => row.id);
      let revoked = 0;
      const pkceVerifierRefs: string[] = [];
      const tokenRefs = (hasMore ? rows.slice(0, limit) : rows)
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

  revokeBinding = async (
    connectorId: string,
  ): Promise<PlatformUserConnectorBindingItem | undefined> => {
    return (await this.revokeBindingWithPreviousSecret(connectorId))?.binding;
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

const sqlIncrement = (column: typeof platformUserConnectorBindings.revision) => sql`${column} + 1`;

const escapeLike = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
