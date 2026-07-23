import { eq } from 'drizzle-orm';

import {
  DEFAULT_PLATFORM_SIDEBAR_LAYOUT,
  type PlatformSidebarLayout,
  type SidebarLayoutMode,
} from '@/types/platform/sidebarLayout';

import { platformSidebarLayout } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

/** Singleton row identity — there is exactly one platform sidebar-layout document. */
export const PLATFORM_SIDEBAR_LAYOUT_ID = 'global';

/**
 * Reads and writes the singleton {@link platformSidebarLayout} row.
 * Absent row → built-in default (mode 'user', no platform layout).
 */
export class PlatformSidebarLayoutModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  get = async (): Promise<PlatformSidebarLayout> => {
    const [row] = await this.db
      .select()
      .from(platformSidebarLayout)
      .where(eq(platformSidebarLayout.id, PLATFORM_SIDEBAR_LAYOUT_ID))
      .limit(1);

    if (!row) return { ...DEFAULT_PLATFORM_SIDEBAR_LAYOUT };

    return {
      layout: row.layout ?? null,
      mode: (row.mode as SidebarLayoutMode) === 'platform' ? 'platform' : 'user',
    };
  };

  update = async (
    actorId: string | null,
    next: PlatformSidebarLayout,
  ): Promise<PlatformSidebarLayout> => {
    await this.db
      .insert(platformSidebarLayout)
      .values({
        id: PLATFORM_SIDEBAR_LAYOUT_ID,
        layout: next.layout,
        mode: next.mode,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        set: {
          layout: next.layout,
          mode: next.mode,
          updatedAt: new Date(),
          updatedBy: actorId,
        },
        target: platformSidebarLayout.id,
      });

    return next;
  };
}
