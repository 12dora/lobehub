import { count, gt, sql } from 'drizzle-orm';

import type {
  ModerationCategory,
  ModerationDecisionSource,
} from '@/const/platform/contentModeration';

import { platformContentModerationDecisions } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export interface ContentModerationDecisionRow {
  categories: Partial<Record<ModerationCategory, number>>;
  createdAt: Date;
  expiresAt: Date;
  hitCount: number;
  lastHitAt: Date;
  promptHash: string;
  source: ModerationDecisionSource;
}

/**
 * Hash-keyed classifier decision cache.
 *
 * Deep-import this file from the runtime hot path — do not pull `models/platform`.
 */
export class PlatformContentModerationDecisionModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (hash: string): Promise<ContentModerationDecisionRow | null> => {
    const [row] = await this.db
      .select()
      .from(platformContentModerationDecisions)
      .where(
        sql`${platformContentModerationDecisions.promptHash} = ${hash} AND ${platformContentModerationDecisions.expiresAt} > now()`,
      )
      .limit(1);

    return row ? this.toRow(row) : null;
  };

  put = async (params: {
    categories: Partial<Record<ModerationCategory, number>>;
    hash: string;
    source: ModerationDecisionSource;
    ttlHours: number;
  }): Promise<void> => {
    if (params.ttlHours <= 0) return;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.ttlHours * 60 * 60 * 1000);

    await this.db
      .insert(platformContentModerationDecisions)
      .values({
        categories: params.categories,
        expiresAt,
        hitCount: 1,
        lastHitAt: now,
        promptHash: params.hash,
        source: params.source,
      })
      .onConflictDoUpdate({
        set: {
          categories: params.categories,
          expiresAt,
          hitCount: sql`${platformContentModerationDecisions.hitCount} + 1`,
          lastHitAt: now,
          source: params.source,
        },
        target: platformContentModerationDecisions.promptHash,
      });
  };

  count = async (): Promise<number> => {
    const [row] = await this.db
      .select({ value: count() })
      .from(platformContentModerationDecisions)
      .where(gt(platformContentModerationDecisions.expiresAt, sql`now()`));
    return Number(row?.value ?? 0);
  };

  clear = async (): Promise<number> => {
    const [before] = await this.db
      .select({ value: count() })
      .from(platformContentModerationDecisions);
    const total = Number(before?.value ?? 0);
    if (total === 0) return 0;
    await this.db.delete(platformContentModerationDecisions);
    return total;
  };

  purgeExpired = async (): Promise<number> => {
    const deleted = await this.db
      .delete(platformContentModerationDecisions)
      .where(sql`${platformContentModerationDecisions.expiresAt} <= now()`)
      .returning({ hash: platformContentModerationDecisions.promptHash });
    return deleted.length;
  };

  private toRow = (
    row: typeof platformContentModerationDecisions.$inferSelect,
  ): ContentModerationDecisionRow => ({
    categories: row.categories,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    hitCount: row.hitCount,
    lastHitAt: row.lastHitAt,
    promptHash: row.promptHash,
    source: row.source,
  });
}
