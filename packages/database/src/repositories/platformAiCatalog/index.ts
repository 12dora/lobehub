import { and, asc, desc, eq, gt, ilike, inArray, lt, max, or } from 'drizzle-orm';
import type { AiModelType } from 'model-bank';

import {
  type NewPlatformAiModel,
  type NewPlatformAiProvider,
  type PlatformAiModelItem,
  platformAiModels,
  type PlatformAiProviderItem,
  platformAiProviders,
  type PlatformAiProviderSecretItem,
  platformAiProviderSecrets,
  type PlatformResourceRevisionItem,
  platformResourceRevisions,
  type PlatformResourceStatus,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export interface PlatformAiProviderPage {
  items: PlatformAiProviderItem[];
  nextCursor: string | null;
}

export interface PlatformAiModelCursor {
  id: string;
  modelKey: string;
  providerKey: string;
  sort: number;
}

export interface PlatformAiModelPage {
  items: { model: PlatformAiModelItem; providerKey: string }[];
  nextCursor: PlatformAiModelCursor | null;
}

/**
 * Persistence boundary for the global AI catalog.
 *
 * Provider/model writes are always scoped by both ids where applicable so a
 * model id from another provider cannot be used as a confused-deputy update.
 */
export class PlatformAiCatalogRepository {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  createModel = async (values: NewPlatformAiModel): Promise<PlatformAiModelItem> => {
    const [row] = await this.db.insert(platformAiModels).values(values).returning();
    return row;
  };

  createProvider = async (values: NewPlatformAiProvider): Promise<PlatformAiProviderItem> => {
    const [row] = await this.db.insert(platformAiProviders).values(values).returning();
    return row;
  };

  deleteModel = async (
    providerId: string,
    id: string,
  ): Promise<PlatformAiModelItem | undefined> => {
    const [row] = await this.db
      .delete(platformAiModels)
      .where(and(eq(platformAiModels.providerId, providerId), eq(platformAiModels.id, id)))
      .returning();
    return row;
  };

  getModel = async (providerId: string, id: string): Promise<PlatformAiModelItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAiModels)
      .where(and(eq(platformAiModels.providerId, providerId), eq(platformAiModels.id, id)))
      .limit(1);
    return row;
  };

  getProvider = async (id: string): Promise<PlatformAiProviderItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, id))
      .limit(1);
    return row;
  };

  getProviderByKey = async (providerKey: string): Promise<PlatformAiProviderItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.providerKey, providerKey))
      .limit(1);
    return row;
  };

  getProviderSecretVersion = async (
    providerId: string,
    fingerprint: string,
  ): Promise<PlatformAiProviderSecretItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformAiProviderSecrets)
      .where(
        and(
          eq(platformAiProviderSecrets.providerId, providerId),
          eq(platformAiProviderSecrets.fingerprint, fingerprint),
        ),
      )
      .limit(1);
    return rows[0];
  };

  storeProviderSecretVersion = async (params: {
    ciphertext: string;
    fingerprint: string;
    keyVersion: number;
    providerId: string;
  }): Promise<PlatformAiProviderSecretItem> => {
    const [row] = await this.db
      .insert(platformAiProviderSecrets)
      .values(params)
      .onConflictDoUpdate({
        set: { ciphertext: params.ciphertext, keyVersion: params.keyVersion },
        target: [platformAiProviderSecrets.providerId, platformAiProviderSecrets.fingerprint],
      })
      .returning();
    return row;
  };

  getLatestPublishedProviderRevision = async (
    providerId: string,
  ): Promise<PlatformResourceRevisionItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'provider'),
          eq(platformResourceRevisions.resourceId, providerId),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .orderBy(desc(platformResourceRevisions.revision))
      .limit(1);
    return rows[0];
  };

  getProviderRevision = async (
    providerId: string,
    revision: number,
  ): Promise<PlatformResourceRevisionItem | undefined> => {
    const rows = await this.db
      .select()
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'provider'),
          eq(platformResourceRevisions.resourceId, providerId),
          eq(platformResourceRevisions.revision, revision),
        ),
      )
      .limit(1);
    return rows[0];
  };

  listProviderRevisionMetadata = async (params: {
    beforeRevision?: number;
    limit?: number;
    providerId: string;
  }) => {
    const limit = Math.min(params.limit ?? 50, 100);
    const conditions = [
      eq(platformResourceRevisions.resourceType, 'provider'),
      eq(platformResourceRevisions.resourceId, params.providerId),
    ];
    if (params.beforeRevision) {
      conditions.push(lt(platformResourceRevisions.revision, params.beforeRevision));
    }
    const rows = await this.db
      .select({
        checksum: platformResourceRevisions.checksum,
        comment: platformResourceRevisions.comment,
        publishedAt: platformResourceRevisions.publishedAt,
        publishedBy: platformResourceRevisions.publishedBy,
        revision: platformResourceRevisions.revision,
        status: platformResourceRevisions.status,
      })
      .from(platformResourceRevisions)
      .where(and(...conditions))
      .orderBy(desc(platformResourceRevisions.revision))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.revision ?? null) : null,
    };
  };

  listLatestPublishedProviderRevisions = async (): Promise<PlatformResourceRevisionItem[]> => {
    const latest = this.db
      .select({
        resourceId: platformResourceRevisions.resourceId,
        latestRevision: max(platformResourceRevisions.revision).as('latest_revision'),
      })
      .from(platformResourceRevisions)
      .where(and(eq(platformResourceRevisions.resourceType, 'provider')))
      .groupBy(platformResourceRevisions.resourceId)
      .as('latest_provider_revision');

    return this.db
      .select({
        checksum: platformResourceRevisions.checksum,
        comment: platformResourceRevisions.comment,
        createdAt: platformResourceRevisions.createdAt,
        createdBy: platformResourceRevisions.createdBy,
        id: platformResourceRevisions.id,
        payload: platformResourceRevisions.payload,
        publishedAt: platformResourceRevisions.publishedAt,
        publishedBy: platformResourceRevisions.publishedBy,
        resourceId: platformResourceRevisions.resourceId,
        resourceType: platformResourceRevisions.resourceType,
        revision: platformResourceRevisions.revision,
        secretFingerprint: platformResourceRevisions.secretFingerprint,
        status: platformResourceRevisions.status,
      })
      .from(platformResourceRevisions)
      .innerJoin(
        latest,
        and(
          eq(platformResourceRevisions.resourceId, latest.resourceId),
          eq(platformResourceRevisions.revision, latest.latestRevision),
        ),
      )
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'provider'),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .orderBy(asc(platformResourceRevisions.resourceId));
  };

  listModels = async (providerId: string): Promise<PlatformAiModelItem[]> => {
    return this.db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, providerId))
      .orderBy(asc(platformAiModels.sort), asc(platformAiModels.modelKey));
  };

  listAllModels = async (params: {
    cursor?: PlatformAiModelCursor;
    enabled?: boolean;
    limit?: number;
    providerKey?: string;
    query?: string;
    status?: PlatformResourceStatus;
    type?: AiModelType;
  }): Promise<PlatformAiModelPage> => {
    const limit = Math.min(params.limit ?? 50, 100);
    const conditions = [];
    if (params.providerKey) {
      conditions.push(eq(platformAiProviders.providerKey, params.providerKey));
    }
    if (params.type) conditions.push(eq(platformAiModels.type, params.type));
    if (params.status) conditions.push(eq(platformAiModels.status, params.status));
    if (params.enabled !== undefined) conditions.push(eq(platformAiModels.enabled, params.enabled));
    if (params.query) {
      const query = `%${params.query}%`;
      conditions.push(
        or(
          ilike(platformAiModels.modelKey, query),
          ilike(platformAiModels.displayName, query),
          ilike(platformAiProviders.providerKey, query),
          ilike(platformAiProviders.displayName, query),
        )!,
      );
    }
    if (params.cursor) {
      const cursor = params.cursor;
      conditions.push(
        or(
          gt(platformAiProviders.providerKey, cursor.providerKey),
          and(
            eq(platformAiProviders.providerKey, cursor.providerKey),
            gt(platformAiModels.sort, cursor.sort),
          ),
          and(
            eq(platformAiProviders.providerKey, cursor.providerKey),
            eq(platformAiModels.sort, cursor.sort),
            gt(platformAiModels.modelKey, cursor.modelKey),
          ),
          and(
            eq(platformAiProviders.providerKey, cursor.providerKey),
            eq(platformAiModels.sort, cursor.sort),
            eq(platformAiModels.modelKey, cursor.modelKey),
            gt(platformAiModels.id, cursor.id),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select({ model: platformAiModels, providerKey: platformAiProviders.providerKey })
      .from(platformAiModels)
      .innerJoin(platformAiProviders, eq(platformAiModels.providerId, platformAiProviders.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        asc(platformAiProviders.providerKey),
        asc(platformAiModels.sort),
        asc(platformAiModels.modelKey),
        asc(platformAiModels.id),
      )
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? {
              id: last.model.id,
              modelKey: last.model.modelKey,
              providerKey: last.providerKey,
              sort: last.model.sort,
            }
          : null,
    };
  };

  listProviders = async (params: {
    cursor?: string;
    enabled?: boolean;
    limit?: number;
    query?: string;
    source?: string;
    status?: PlatformResourceStatus;
  }): Promise<PlatformAiProviderPage> => {
    const limit = Math.min(params.limit ?? 50, 100);
    const conditions = [];
    if (params.cursor) conditions.push(gt(platformAiProviders.providerKey, params.cursor));
    if (params.enabled !== undefined) {
      conditions.push(eq(platformAiProviders.enabled, params.enabled));
    }
    if (params.query) {
      const query = `%${params.query}%`;
      conditions.push(
        or(
          ilike(platformAiProviders.providerKey, query),
          ilike(platformAiProviders.displayName, query),
          ilike(platformAiProviders.description, query),
        )!,
      );
    }
    if (params.source) conditions.push(eq(platformAiProviders.source, params.source));
    if (params.status) conditions.push(eq(platformAiProviders.status, params.status));

    const rows = await this.db
      .select()
      .from(platformAiProviders)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(platformAiProviders.providerKey))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.providerKey ?? null) : null,
    };
  };

  lockProvider = async (id: string): Promise<PlatformAiProviderItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformAiProviders)
      .where(eq(platformAiProviders.id, id))
      .for('update')
      .limit(1);
    return row;
  };

  reorderModels = async (
    providerId: string,
    items: { id: string; sort: number }[],
  ): Promise<number> => {
    if (items.length === 0) return 0;
    const owned = await this.db
      .select({ id: platformAiModels.id })
      .from(platformAiModels)
      .where(
        and(
          eq(platformAiModels.providerId, providerId),
          inArray(
            platformAiModels.id,
            items.map((item) => item.id),
          ),
        ),
      );
    const ownedIds = new Set(owned.map((item) => item.id));
    for (const item of items) {
      if (!ownedIds.has(item.id)) continue;
      await this.db
        .update(platformAiModels)
        .set({ sort: item.sort, status: 'draft', updatedAt: new Date() })
        .where(and(eq(platformAiModels.providerId, providerId), eq(platformAiModels.id, item.id)));
    }
    return ownedIds.size;
  };

  updateModel = async (
    providerId: string,
    id: string,
    values: Partial<Omit<NewPlatformAiModel, 'id' | 'providerId'>>,
  ): Promise<PlatformAiModelItem | undefined> => {
    const [row] = await this.db
      .update(platformAiModels)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(platformAiModels.providerId, providerId), eq(platformAiModels.id, id)))
      .returning();
    return row;
  };

  updateProvider = async (
    id: string,
    values: Partial<Omit<NewPlatformAiProvider, 'id' | 'providerKey'>>,
  ): Promise<PlatformAiProviderItem | undefined> => {
    const [row] = await this.db
      .update(platformAiProviders)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(platformAiProviders.id, id))
      .returning();
    return row;
  };

  completeProviderConnectionTest = async (
    id: string,
    attemptId: string,
    values: Pick<
      NewPlatformAiProvider,
      | 'connectionTestErrorCategory'
      | 'connectionTestLatencyMs'
      | 'connectionTestSanitizedMessage'
      | 'connectionTestStatus'
      | 'connectionTestedAt'
    >,
  ): Promise<boolean> => {
    const rows = await this.db
      .update(platformAiProviders)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(platformAiProviders.id, id),
          eq(platformAiProviders.connectionTestAttemptId, attemptId),
        ),
      )
      .returning({ id: platformAiProviders.id });
    return rows.length === 1;
  };
}
