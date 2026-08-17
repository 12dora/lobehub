import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';

import type {
  NetworkProxySubscriptionKind,
  SubscriptionTraffic,
} from '@/types/platform/networkProxy';

import { platformNetworkProxySubscriptions } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export interface NetworkProxySubscriptionRow {
  createdAt: Date;
  createdBy: string | null;
  enabled: boolean;
  excludeFilter: string | null;
  filter: string | null;
  id: string;
  kind: NetworkProxySubscriptionKind;
  lastError: string | null;
  lastUpdateAt: Date | null;
  name: string;
  nodeCount: number | null;
  payloadCiphertext: string | null;
  refreshRequestedAt: Date | null;
  sortOrder: number;
  trafficDownload: number | null;
  trafficExpireAt: Date | null;
  trafficTotal: number | null;
  trafficUpload: number | null;
  updatedAt: Date;
  updateIntervalSec: number | null;
  urlCiphertext: string | null;
  urlHost: string | null;
  userAgent: string | null;
}

export interface NetworkProxySubscriptionCreateValues {
  createdBy?: string | null;
  enabled: boolean;
  excludeFilter?: string | null;
  filter?: string | null;
  kind: NetworkProxySubscriptionKind;
  name: string;
  payloadCiphertext?: string | null;
  sortOrder: number;
  updateIntervalSec?: number | null;
  urlCiphertext?: string | null;
  urlHost?: string | null;
  userAgent?: string | null;
}

export interface NetworkProxySubscriptionUpdatePatch {
  enabled?: boolean;
  excludeFilter?: string | null;
  filter?: string | null;
  name?: string;
  payloadCiphertext?: string | null;
  sortOrder?: number;
  updateIntervalSec?: number | null;
  urlCiphertext?: string | null;
  urlHost?: string | null;
  userAgent?: string | null;
}

export interface NetworkProxySubscriptionFetchResult {
  error?: string | null;
  fetchedAt: Date;
  nodeCount?: number | null;
  traffic?: SubscriptionTraffic | null;
}

const definedEntries = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;

/**
 * CRUD + fetch bookkeeping for {@link platformNetworkProxySubscriptions}.
 *
 * Deep-import this file from the runtime hot path — do not pull `models/platform`.
 */
export class NetworkProxySubscriptionModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  list = async (): Promise<NetworkProxySubscriptionRow[]> => {
    const rows = await this.db
      .select()
      .from(platformNetworkProxySubscriptions)
      .orderBy(
        asc(platformNetworkProxySubscriptions.sortOrder),
        asc(platformNetworkProxySubscriptions.createdAt),
      );
    return rows.map((row) => this.toRow(row));
  };

  getById = async (id: string): Promise<NetworkProxySubscriptionRow | null> => {
    const [row] = await this.db
      .select()
      .from(platformNetworkProxySubscriptions)
      .where(eq(platformNetworkProxySubscriptions.id, id))
      .limit(1);
    return row ? this.toRow(row) : null;
  };

  create = async (
    values: NetworkProxySubscriptionCreateValues,
  ): Promise<NetworkProxySubscriptionRow> => {
    const [inserted] = await this.db
      .insert(platformNetworkProxySubscriptions)
      .values({
        createdBy: values.createdBy ?? null,
        enabled: values.enabled,
        excludeFilter: values.excludeFilter ?? null,
        filter: values.filter ?? null,
        kind: values.kind,
        name: values.name,
        payloadCiphertext: values.payloadCiphertext ?? null,
        sortOrder: values.sortOrder,
        updateIntervalSec: values.updateIntervalSec ?? null,
        urlCiphertext: values.urlCiphertext ?? null,
        urlHost: values.urlHost ?? null,
        userAgent: values.userAgent ?? null,
      })
      .returning();
    return this.toRow(inserted);
  };

  update = async (
    id: string,
    patch: NetworkProxySubscriptionUpdatePatch,
  ): Promise<NetworkProxySubscriptionRow | null> => {
    const set = definedEntries({
      enabled: patch.enabled,
      excludeFilter: patch.excludeFilter,
      filter: patch.filter,
      name: patch.name,
      payloadCiphertext: patch.payloadCiphertext,
      sortOrder: patch.sortOrder,
      updateIntervalSec: patch.updateIntervalSec,
      updatedAt: new Date(),
      urlCiphertext: patch.urlCiphertext,
      urlHost: patch.urlHost,
      userAgent: patch.userAgent,
    });
    const [updated] = await this.db
      .update(platformNetworkProxySubscriptions)
      .set(set)
      .where(eq(platformNetworkProxySubscriptions.id, id))
      .returning();
    return updated ? this.toRow(updated) : null;
  };

  delete = async (id: string): Promise<void> => {
    await this.db
      .delete(platformNetworkProxySubscriptions)
      .where(eq(platformNetworkProxySubscriptions.id, id));
  };

  requestRefresh = async (id: string, at: Date): Promise<NetworkProxySubscriptionRow | null> => {
    const [updated] = await this.db
      .update(platformNetworkProxySubscriptions)
      .set({ refreshRequestedAt: at, updatedAt: new Date() })
      .where(eq(platformNetworkProxySubscriptions.id, id))
      .returning();
    return updated ? this.toRow(updated) : null;
  };

  /**
   * Success writes are gated by `last_update_at IS NULL OR last_update_at < fetchedAt`
   * so concurrent instance fetchers stay idempotent. Failures always overwrite `last_error`.
   */
  recordFetchResult = async (
    id: string,
    result: NetworkProxySubscriptionFetchResult,
  ): Promise<void> => {
    if (result.error) {
      await this.db
        .update(platformNetworkProxySubscriptions)
        .set({ lastError: result.error, updatedAt: new Date() })
        .where(eq(platformNetworkProxySubscriptions.id, id));
      return;
    }

    const set: Record<string, Date | number | null> = {
      lastError: null,
      lastUpdateAt: result.fetchedAt,
      updatedAt: new Date(),
    };
    if (result.nodeCount !== undefined) set.nodeCount = result.nodeCount;
    if (result.traffic) {
      set.trafficDownload = result.traffic.download;
      set.trafficTotal = result.traffic.total;
      set.trafficUpload = result.traffic.upload;
      set.trafficExpireAt = result.traffic.expireAt ? new Date(result.traffic.expireAt) : null;
    }

    await this.db
      .update(platformNetworkProxySubscriptions)
      .set(set)
      .where(
        and(
          eq(platformNetworkProxySubscriptions.id, id),
          or(
            isNull(platformNetworkProxySubscriptions.lastUpdateAt),
            lt(platformNetworkProxySubscriptions.lastUpdateAt, result.fetchedAt),
          ),
        ),
      );
  };

  private toRow = (
    row: typeof platformNetworkProxySubscriptions.$inferSelect,
  ): NetworkProxySubscriptionRow => ({
    createdAt: row.createdAt,
    createdBy: row.createdBy ?? null,
    enabled: row.enabled,
    excludeFilter: row.excludeFilter ?? null,
    filter: row.filter ?? null,
    id: row.id,
    kind: row.kind,
    lastError: row.lastError ?? null,
    lastUpdateAt: row.lastUpdateAt ?? null,
    name: row.name,
    nodeCount: row.nodeCount ?? null,
    payloadCiphertext: row.payloadCiphertext ?? null,
    refreshRequestedAt: row.refreshRequestedAt ?? null,
    sortOrder: row.sortOrder,
    trafficDownload: row.trafficDownload ?? null,
    trafficExpireAt: row.trafficExpireAt ?? null,
    trafficTotal: row.trafficTotal ?? null,
    trafficUpload: row.trafficUpload ?? null,
    updateIntervalSec: row.updateIntervalSec ?? null,
    updatedAt: row.updatedAt,
    urlCiphertext: row.urlCiphertext ?? null,
    urlHost: row.urlHost ?? null,
    userAgent: row.userAgent ?? null,
  });
}
