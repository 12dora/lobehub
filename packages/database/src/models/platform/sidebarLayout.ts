import { and, eq } from 'drizzle-orm';

import {
  DEFAULT_PLATFORM_SIDEBAR_LAYOUT,
  type PlatformSidebarLayout,
  type SidebarLayoutMode,
} from '@/types/platform/sidebarLayout';

import { platformSidebarLayout } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';

/** Singleton row identity — there is exactly one platform sidebar-layout document. */
export const PLATFORM_SIDEBAR_LAYOUT_ID = 'global';

/** Layout document fields without the CAS token (writers pass expectedRevision separately). */
export type PlatformSidebarLayoutDocument = Pick<PlatformSidebarLayout, 'layout' | 'mode'>;

/**
 * Reads and writes the singleton {@link platformSidebarLayout} row.
 * Absent row → built-in default (mode 'user', no platform layout, revision 0).
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
      revision: row.revision,
    };
  };

  /**
   * Persist the full sidebar-layout document with CAS.
   * @throws PlatformRevisionConflictError when expectedRevision mismatches
   * @throws Error when mode is not an allowed value (fail closed)
   */
  update = async (
    actorId: string | null,
    next: PlatformSidebarLayoutDocument,
    expectedRevision: number,
  ): Promise<PlatformSidebarLayout> => {
    // Fail closed at the model boundary before insert: mode must be an exact allowed value.
    if (next.mode !== 'user' && next.mode !== 'platform') {
      throw new Error(`Invalid sidebar layout mode: ${String(next.mode)}`);
    }

    const run = async (db: LobeChatDatabase | Transaction) => {
      const [locked] = await db
        .select()
        .from(platformSidebarLayout)
        .where(eq(platformSidebarLayout.id, PLATFORM_SIDEBAR_LAYOUT_ID))
        .limit(1)
        .for('update');

      const current: PlatformSidebarLayout = locked
        ? {
            layout: locked.layout ?? null,
            mode: (locked.mode as SidebarLayoutMode) === 'platform' ? 'platform' : 'user',
            revision: locked.revision,
          }
        : { ...DEFAULT_PLATFORM_SIDEBAR_LAYOUT };

      if (current.revision !== expectedRevision) {
        throw new PlatformRevisionConflictError(
          'Sidebar layout revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: current.revision,
            expectedRevision,
            resourceId: PLATFORM_SIDEBAR_LAYOUT_ID,
            resourceType: 'sidebar_layout',
          },
        );
      }

      const nextRevision = current.revision + 1;
      const document: PlatformSidebarLayoutDocument = {
        layout: next.layout,
        mode: next.mode,
      };

      if (!locked) {
        const [inserted] = await db
          .insert(platformSidebarLayout)
          .values({
            id: PLATFORM_SIDEBAR_LAYOUT_ID,
            layout: document.layout,
            mode: document.mode,
            revision: nextRevision,
            updatedBy: actorId,
          })
          .onConflictDoNothing({ target: platformSidebarLayout.id })
          .returning();
        if (!inserted) {
          throw new PlatformRevisionConflictError(
            'Sidebar layout revision conflict: concurrent first-write',
            {
              expectedRevision,
              resourceId: PLATFORM_SIDEBAR_LAYOUT_ID,
              resourceType: 'sidebar_layout',
            },
          );
        }
        return { ...document, revision: nextRevision };
      }

      const [updated] = await db
        .update(platformSidebarLayout)
        .set({
          layout: document.layout,
          mode: document.mode,
          revision: nextRevision,
          updatedAt: new Date(),
          updatedBy: actorId,
        })
        .where(
          and(
            eq(platformSidebarLayout.id, PLATFORM_SIDEBAR_LAYOUT_ID),
            eq(platformSidebarLayout.revision, expectedRevision),
          ),
        )
        .returning();

      if (!updated) {
        throw new PlatformRevisionConflictError(
          'Sidebar layout revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: current.revision,
            expectedRevision,
            resourceId: PLATFORM_SIDEBAR_LAYOUT_ID,
            resourceType: 'sidebar_layout',
          },
        );
      }

      return { ...document, revision: nextRevision };
    };

    // Callers that need atomicity (router + audit) pass a Transaction; do not nest.
    return run(this.db);
  };
}
