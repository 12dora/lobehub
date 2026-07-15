import { and, eq } from 'drizzle-orm';

import {
  type NewPlatformEasyauthGrantSnapshot,
  type PlatformEasyauthGrantSnapshotItem,
  platformEasyauthGrantSnapshots,
} from '../../schemas/platform/easyauth';
import type { LobeChatDatabase, Transaction } from '../../type';

export type { PlatformEasyauthGrantSnapshotItem };

export interface UpsertEasyauthGrantSnapshotParams {
  accessGranted: boolean;
  appKey: string;
  catalogVersion: number;
  degraded?: boolean;
  expiresAt?: Date | null;
  externalUserId: string;
  fetchedAt?: Date;
  grants: unknown[];
  grantVersion: number;
  groups: unknown[];
  lastError?: string | null;
  snapshotVersion: string;
  userId: string;
}

export class EasyauthGrantSnapshotModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  findByUser = async (
    userId: string,
    appKey = 'aihub',
  ): Promise<PlatformEasyauthGrantSnapshotItem | undefined> => {
    return this.db.query.platformEasyauthGrantSnapshots.findFirst({
      where: and(
        eq(platformEasyauthGrantSnapshots.userId, userId),
        eq(platformEasyauthGrantSnapshots.appKey, appKey),
      ),
    });
  };

  upsert = async (
    params: UpsertEasyauthGrantSnapshotParams,
  ): Promise<PlatformEasyauthGrantSnapshotItem> => {
    const values: NewPlatformEasyauthGrantSnapshot = {
      accessGranted: params.accessGranted,
      appKey: params.appKey,
      catalogVersion: params.catalogVersion,
      degraded: params.degraded ?? false,
      expiresAt: params.expiresAt ?? null,
      externalUserId: params.externalUserId,
      fetchedAt: params.fetchedAt ?? new Date(),
      grantVersion: params.grantVersion,
      grants: params.grants,
      groups: params.groups,
      lastError: params.lastError ?? null,
      snapshotVersion: params.snapshotVersion,
      userId: params.userId,
    };

    const existing = await this.findByUser(params.userId, params.appKey);
    if (existing) {
      const [row] = await this.db
        .update(platformEasyauthGrantSnapshots)
        .set({
          accessGranted: values.accessGranted,
          catalogVersion: values.catalogVersion,
          degraded: values.degraded,
          expiresAt: values.expiresAt,
          externalUserId: values.externalUserId,
          fetchedAt: values.fetchedAt,
          grantVersion: values.grantVersion,
          grants: values.grants,
          groups: values.groups,
          lastError: values.lastError,
          snapshotVersion: values.snapshotVersion,
        })
        .where(eq(platformEasyauthGrantSnapshots.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await this.db.insert(platformEasyauthGrantSnapshots).values(values).returning();
    return row;
  };

  markDegraded = async (
    userId: string,
    lastError: string,
    appKey = 'aihub',
  ): Promise<PlatformEasyauthGrantSnapshotItem | undefined> => {
    const existing = await this.findByUser(userId, appKey);
    if (!existing) return undefined;

    const [row] = await this.db
      .update(platformEasyauthGrantSnapshots)
      .set({
        degraded: true,
        lastError,
      })
      .where(eq(platformEasyauthGrantSnapshots.id, existing.id))
      .returning();
    return row;
  };
}
