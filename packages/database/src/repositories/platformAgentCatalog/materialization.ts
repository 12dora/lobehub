/**
 * Agent materialization / tombstone aggregate (DB-005).
 */

import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';

import {
  type PlatformUserAgentMaterializationErrorCategory,
  type PlatformUserAgentMaterializationItem,
  platformUserAgentMaterializations,
  type PlatformUserAgentMaterializationStatus,
  platformUserAgentMaterializationTombstones,
} from '../../schemas/platform';
import type { Transaction } from '../../type';
import { inTransaction } from '../platform/tx';
import { PlatformAgentAssignmentRepository } from './assignment';
import { PlatformAgentMaterializationRaceError } from './types';

/** A real materialization carries a local agent or a sync stamp; visibility-only rows do not. */
const isRealMaterialization = (item: PlatformUserAgentMaterializationItem) =>
  item.materializedAgentId !== null || item.lastSyncedAt !== null;

interface ResolvedMaterializationWrite {
  hasHidden: boolean;
  hasLastErrorCategory: boolean;
  hasMaterializedAgent: boolean;
  lastErrorCategory: PlatformUserAgentMaterializationErrorCategory | null | undefined;
  status: PlatformUserAgentMaterializationStatus | undefined;
}

const resolveMaterializationWrite = (params: {
  hidden?: boolean;
  lastErrorCategory?: PlatformUserAgentMaterializationErrorCategory | null;
  materializedAgentId?: string | null;
  status?: PlatformUserAgentMaterializationStatus;
}): ResolvedMaterializationWrite => {
  const hasHidden = Object.hasOwn(params, 'hidden') && params.hidden !== undefined;
  const hasLastErrorCategory =
    Object.hasOwn(params, 'lastErrorCategory') && params.lastErrorCategory !== undefined;
  const hasMaterializedAgent =
    Object.hasOwn(params, 'materializedAgentId') && params.materializedAgentId !== undefined;
  const status =
    params.status ??
    (hasMaterializedAgent
      ? params.materializedAgentId === null
        ? 'pending'
        : 'materialized'
      : undefined);
  const lastErrorCategory = hasLastErrorCategory
    ? params.lastErrorCategory
    : status && status !== 'error'
      ? null
      : undefined;
  return {
    hasHidden,
    hasLastErrorCategory,
    hasMaterializedAgent,
    lastErrorCategory,
    status,
  };
};

const matchesDesiredState = (
  item: PlatformUserAgentMaterializationItem,
  params: {
    hidden?: boolean;
    materializedAgentId?: string | null;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
  },
  resolved: ResolvedMaterializationWrite,
) =>
  isRealMaterialization(item) &&
  item.platformAgentVersionId === params.platformAgentVersionId &&
  item.platformAgentVersionChecksum === params.platformAgentVersionChecksum &&
  (!resolved.hasHidden || item.hidden === params.hidden) &&
  (!resolved.hasMaterializedAgent || item.materializedAgentId === params.materializedAgentId) &&
  (!(resolved.hasLastErrorCategory || (resolved.status && resolved.status !== 'error')) ||
    item.lastErrorCategory === resolved.lastErrorCategory) &&
  (!resolved.status || item.status === resolved.status);

export class PlatformAgentMaterializationRepository extends PlatformAgentAssignmentRepository {
  getMaterialization = async (
    userId: string,
    platformAgentId: string,
  ): Promise<PlatformUserAgentMaterializationItem | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.platformAgentId, platformAgentId),
        ),
      )
      .limit(1);
    return row;
  };

  /**
   * Owner-scoped set of local Agent ids that are materializations of a platform Agent for the
   * given user. Strictly filtered by the trusted `userId`. Used by the unified list to
   * de-duplicate: a materialized local row is represented by its platform list item, never a
   * second local entry. Includes hard-delete tombstones so surviving local clones stay hidden
   * after the live mapping is removed. Only rows with a real local Agent id are returned.
   */
  listMaterializedAgentIds = async (userId: string): Promise<Set<string>> => {
    const [live, tombstoned] = await Promise.all([
      this.db
        .select({ materializedAgentId: platformUserAgentMaterializations.materializedAgentId })
        .from(platformUserAgentMaterializations)
        .where(
          and(
            eq(platformUserAgentMaterializations.userId, userId),
            isNotNull(platformUserAgentMaterializations.materializedAgentId),
          ),
        ),
      this.db
        .select({
          materializedAgentId: platformUserAgentMaterializationTombstones.materializedAgentId,
        })
        .from(platformUserAgentMaterializationTombstones)
        .where(eq(platformUserAgentMaterializationTombstones.userId, userId)),
    ]);
    return new Set([
      ...live.map((row) => row.materializedAgentId as string),
      ...tombstoned.map((row) => row.materializedAgentId),
    ]);
  };

  /**
   * Owner-scoped reverse lookup: given a local Agent id, return the platform Agent it was
   * materialized from for THIS user, or null. Strictly filtered by the trusted `userId`, so a local
   * id belonging to another user (or an ordinary, non-materialized Agent) can never resolve to a
   * platform Agent. Used by the chat runtime to force a materialized local id back through
   * owner-scoped entitlement + the exact pinned snapshot instead of running the local row directly.
   * Tombstoned (hard-deleted catalog) rows still resolve to their former platform id so mutation
   * guards and runtime stay fail-closed rather than treating the clone as an ordinary assistant.
   */
  getPlatformAgentIdByMaterializedAgentId = async (
    userId: string,
    materializedAgentId: string,
  ): Promise<string | null> => {
    const [row] = await this.db
      .select({ platformAgentId: platformUserAgentMaterializations.platformAgentId })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.materializedAgentId, materializedAgentId),
        ),
      )
      .limit(1);
    if (row?.platformAgentId) return row.platformAgentId;

    const [tombstone] = await this.db
      .select({
        formerPlatformAgentId: platformUserAgentMaterializationTombstones.formerPlatformAgentId,
      })
      .from(platformUserAgentMaterializationTombstones)
      .where(
        and(
          eq(platformUserAgentMaterializationTombstones.userId, userId),
          eq(platformUserAgentMaterializationTombstones.materializedAgentId, materializedAgentId),
        ),
      )
      .limit(1);
    return tombstone?.formerPlatformAgentId ?? null;
  };

  /** Owner-scoped batch reverse lookup used by mutation guards (includes hard-delete tombstones). */
  getPlatformAgentIdsByMaterializedAgentIds = async (
    userId: string,
    materializedAgentIds: string[],
  ): Promise<Set<string>> => {
    if (materializedAgentIds.length === 0) return new Set();
    const [live, tombstoned] = await Promise.all([
      this.db
        .select({ platformAgentId: platformUserAgentMaterializations.platformAgentId })
        .from(platformUserAgentMaterializations)
        .where(
          and(
            eq(platformUserAgentMaterializations.userId, userId),
            inArray(platformUserAgentMaterializations.materializedAgentId, materializedAgentIds),
          ),
        ),
      this.db
        .select({
          formerPlatformAgentId: platformUserAgentMaterializationTombstones.formerPlatformAgentId,
        })
        .from(platformUserAgentMaterializationTombstones)
        .where(
          and(
            eq(platformUserAgentMaterializationTombstones.userId, userId),
            inArray(
              platformUserAgentMaterializationTombstones.materializedAgentId,
              materializedAgentIds,
            ),
          ),
        ),
    ]);
    return new Set([
      ...live.map(({ platformAgentId }) => platformAgentId),
      ...tombstoned.map(({ formerPlatformAgentId }) => formerPlatformAgentId),
    ]);
  };

  /**
   * Delayed materialization of a local user-owned Agent for a platform Agent, transactional and
   * owner-scoped (R-materialize). The whole thing runs under the per-Agent reference lock inside
   * ONE transaction so that:
   *
   * - Local Agent creation (`createLocalAgent`, run against the SAME tx) and the mapping insert
   *   commit atomically. N concurrent callers therefore leave exactly one mapping and one local
   *   Agent: the lock serializes them, the first sees no mapping and creates one, the rest see the
   *   existing mapping and reuse it — never creating a second Agent, never orphaning one.
   * - It joins the referenceable-Agent protocol: an Agent archived under the shared lock is
   *   rejected (`{ reason: 'archived' }`) instead of producing an orphan reference.
   * - The mapping is upgraded in place from a pure visibility-only row (materializedAgentId NULL)
   *   without disturbing the owner's hidden preference.
   *
   * The exact pinned `{ versionId, checksum }` is written verbatim (FK-validated against the
   * immutable version), so the local row can never point at a version/checksum the caller did not
   * pin. No secret is written — the mapping carries only ids and a checksum.
   */
  materializeLocalAgent = async (params: {
    createLocalAgent: (tx: Transaction) => Promise<{ id: string }>;
    platformAgentId: string;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
    userId: string;
  }): Promise<
    { agentId: string; created: boolean; ok: true } | { ok: false; reason: 'archived' }
  > =>
    inTransaction(this.db, async (tx) => {
      const scoped = new PlatformAgentMaterializationRepository(tx);
      const agent = await this.lockReferenceableAgent(tx, params.platformAgentId);
      if (!agent) return { ok: false as const, reason: 'archived' as const };

      const existing = await scoped.getMaterialization(params.userId, params.platformAgentId);
      if (existing?.materializedAgentId) {
        return {
          agentId: existing.materializedAgentId,
          created: false as const,
          ok: true as const,
        };
      }

      const local = await params.createLocalAgent(tx);
      const now = new Date();
      const [row] = await tx
        .insert(platformUserAgentMaterializations)
        .values({
          hidden: existing?.hidden ?? false,
          lastSyncedAt: now,
          materializedAgentId: local.id,
          platformAgentId: params.platformAgentId,
          platformAgentVersionChecksum: params.platformAgentVersionChecksum,
          platformAgentVersionId: params.platformAgentVersionId,
          status: 'materialized',
          userId: params.userId,
        })
        .onConflictDoUpdate({
          // Only upgrade a pure visibility-only row; a row that already carries a real local Agent
          // is left untouched (setWhere false → no row returned → treated as a lost race below).
          set: {
            lastErrorCategory: null,
            lastSyncedAt: now,
            materializedAgentId: local.id,
            platformAgentVersionChecksum: params.platformAgentVersionChecksum,
            platformAgentVersionId: params.platformAgentVersionId,
            status: 'materialized',
            updatedAt: now,
          },
          setWhere: isNull(platformUserAgentMaterializations.materializedAgentId),
          target: [
            platformUserAgentMaterializations.userId,
            platformUserAgentMaterializations.platformAgentId,
          ],
        })
        .returning({ materializedAgentId: platformUserAgentMaterializations.materializedAgentId });

      if (row?.materializedAgentId === local.id) {
        return { agentId: local.id, created: true as const, ok: true as const };
      }
      // Unreachable while the per-Agent lock is held (the mapping check above is authoritative).
      // Throwing rolls back this tx — undoing the just-created local Agent — so a caller that
      // retries (re-reads the winning mapping) never leaves an orphan Agent behind.
      throw new PlatformAgentMaterializationRaceError();
    });

  /**
   * Owner-scoped set of platform Agent ids the given user has hidden. Strictly filtered by
   * the trusted `userId`, so one user's visibility choices can never widen another's read.
   */
  listHiddenPlatformAgentIds = async (userId: string): Promise<Set<string>> => {
    const rows = await this.db
      .select({ platformAgentId: platformUserAgentMaterializations.platformAgentId })
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, userId),
          eq(platformUserAgentMaterializations.hidden, true),
        ),
      );
    return new Set(rows.map((row) => row.platformAgentId));
  };

  /**
   * Owner-scoped write of the per-user hidden flag (R1). Joins the referenceable-Agent protocol
   * (hiding an archived Agent is rejected → returns false). A hidden row is written as a pure
   * visibility-only row — `last_synced_at` is left NULL and `materialized_agent_id` NULL — so it
   * is never counted as an archive reference (see `countAgentReferences`). Hiding an Agent that
   * already has a real materialization only flips the flag and preserves its sync/local state.
   *
   * Unhiding deletes a pure visibility-only row (so a hide→unhide cycle leaves no archive blocker)
   * but only clears the flag on a row that carries real materialization state.
   */
  setMaterializationHidden = async (params: {
    hidden: boolean;
    platformAgentId: string;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
    userId: string;
  }): Promise<boolean> =>
    inTransaction(this.db, async (tx) => {
      const agent = await this.lockReferenceableAgent(tx, params.platformAgentId);
      if (!agent) return false;

      const ownerScope = and(
        eq(platformUserAgentMaterializations.userId, params.userId),
        eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
      );

      if (params.hidden) {
        // Never touch last_synced_at: an inserted row stays visibility-only; an existing real
        // materialization keeps its sync/local state and only gains the hidden flag.
        await tx
          .insert(platformUserAgentMaterializations)
          .values({
            hidden: true,
            platformAgentId: params.platformAgentId,
            platformAgentVersionChecksum: params.platformAgentVersionChecksum,
            platformAgentVersionId: params.platformAgentVersionId,
            status: 'pending',
            userId: params.userId,
          })
          .onConflictDoUpdate({
            set: { hidden: true, updatedAt: new Date() },
            target: [
              platformUserAgentMaterializations.userId,
              platformUserAgentMaterializations.platformAgentId,
            ],
          });
        return true;
      }

      // Unhide: drop a pure visibility-only row so it can never linger as an archive blocker …
      const deleted = await tx
        .delete(platformUserAgentMaterializations)
        .where(
          and(
            ownerScope,
            isNull(platformUserAgentMaterializations.materializedAgentId),
            isNull(platformUserAgentMaterializations.lastSyncedAt),
          ),
        )
        .returning({ id: platformUserAgentMaterializations.id });
      // … otherwise (a real materialization row) just clear the flag, preserving its state.
      if (deleted.length === 0) {
        await tx
          .update(platformUserAgentMaterializations)
          .set({ hidden: false, updatedAt: new Date() })
          .where(ownerScope);
      }
      return true;
    });

  upsertMaterialization = async (params: {
    expectedCurrent?: {
      checksum: string;
      versionId: string;
    };
    hidden?: boolean;
    lastErrorCategory?: PlatformUserAgentMaterializationErrorCategory | null;
    materializedAgentId?: string | null;
    platformAgentId: string;
    platformAgentVersionChecksum: string;
    platformAgentVersionId: string;
    status?: PlatformUserAgentMaterializationStatus;
    userId: string;
  }): Promise<PlatformUserAgentMaterializationItem | undefined> =>
    // Materialization is a reference to a platform Agent, so it joins the same
    // referenceable-Agent protocol as assignment writes: reject when the Agent has been
    // archived (or is missing / migration-pending) under the shared per-Agent lock.
    inTransaction(this.db, async (tx) => {
      const scoped = new PlatformAgentMaterializationRepository(tx);
      const agent = await this.lockReferenceableAgent(tx, params.platformAgentId);
      if (!agent) return undefined;

      const resolved = resolveMaterializationWrite(params);
      const expectedCurrent = params.expectedCurrent;
      if (!expectedCurrent) {
        return this.insertOrUpgradeMaterialization(tx, scoped, params, resolved);
      }
      return this.casUpdateMaterialization(tx, scoped, { ...params, expectedCurrent }, resolved);
    });

  /**
   * No-expectedCurrent path: insert when absent; on conflict either return idempotent
   * match, refuse to clobber a real materialization, or upgrade a visibility-only row.
   */
  private insertOrUpgradeMaterialization = async (
    tx: Transaction,
    scoped: PlatformAgentMaterializationRepository,
    params: {
      hidden?: boolean;
      lastErrorCategory?: PlatformUserAgentMaterializationErrorCategory | null;
      materializedAgentId?: string | null;
      platformAgentId: string;
      platformAgentVersionChecksum: string;
      platformAgentVersionId: string;
      userId: string;
    },
    resolved: ResolvedMaterializationWrite,
  ): Promise<PlatformUserAgentMaterializationItem | undefined> => {
    const insertValues = {
      hidden: params.hidden ?? false,
      lastErrorCategory: resolved.lastErrorCategory,
      lastSyncedAt: new Date(),
      materializedAgentId: params.materializedAgentId,
      platformAgentId: params.platformAgentId,
      platformAgentVersionChecksum: params.platformAgentVersionChecksum,
      platformAgentVersionId: params.platformAgentVersionId,
      status: resolved.status ?? 'pending',
      userId: params.userId,
    };
    const [inserted] = await tx
      .insert(platformUserAgentMaterializations)
      .values(insertValues)
      .onConflictDoNothing({
        target: [
          platformUserAgentMaterializations.userId,
          platformUserAgentMaterializations.platformAgentId,
        ],
      })
      .returning();
    if (inserted) return inserted;

    const existing = await scoped.getMaterialization(params.userId, params.platformAgentId);
    if (!existing) return undefined;
    //   1) real materialization already desired → idempotent;
    if (matchesDesiredState(existing, params, resolved)) return existing;
    //   2) real materialization not desired → refuse without CAS;
    if (isRealMaterialization(existing)) return undefined;
    //   3) visibility-only row → upgrade in place.
    return this.upgradeVisibilityOnlyMaterialization(tx, params, resolved);
  };

  /** Upgrade a visibility-only row into a real materialization under the per-Agent lock. */
  private upgradeVisibilityOnlyMaterialization = async (
    tx: Transaction,
    params: {
      hidden?: boolean;
      lastErrorCategory?: PlatformUserAgentMaterializationErrorCategory | null;
      materializedAgentId?: string | null;
      platformAgentId: string;
      platformAgentVersionChecksum: string;
      platformAgentVersionId: string;
      userId: string;
    },
    resolved: ResolvedMaterializationWrite,
  ): Promise<PlatformUserAgentMaterializationItem | undefined> => {
    const resolvedStatus = resolved.status ?? 'pending';
    const [upgraded] = await tx
      .update(platformUserAgentMaterializations)
      .set({
        ...(resolved.hasHidden ? { hidden: params.hidden } : {}),
        ...(resolved.hasMaterializedAgent
          ? { materializedAgentId: params.materializedAgentId }
          : {}),
        lastErrorCategory: resolvedStatus === 'error' ? (params.lastErrorCategory ?? null) : null,
        lastSyncedAt: new Date(),
        platformAgentVersionChecksum: params.platformAgentVersionChecksum,
        platformAgentVersionId: params.platformAgentVersionId,
        status: resolvedStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, params.userId),
          eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
        ),
      )
      .returning();
    return upgraded && matchesDesiredState(upgraded, params, resolved) ? upgraded : undefined;
  };

  /**
   * expectedCurrent CAS path: UPDATE only when version/checksum still match; read-back
   * returns the row only when already a real materialization in the desired state.
   */
  private casUpdateMaterialization = async (
    tx: Transaction,
    scoped: PlatformAgentMaterializationRepository,
    params: {
      expectedCurrent: {
        checksum: string;
        versionId: string;
      };
      hidden?: boolean;
      lastErrorCategory?: PlatformUserAgentMaterializationErrorCategory | null;
      materializedAgentId?: string | null;
      platformAgentId: string;
      platformAgentVersionChecksum: string;
      platformAgentVersionId: string;
      userId: string;
    },
    resolved: ResolvedMaterializationWrite,
  ): Promise<PlatformUserAgentMaterializationItem | undefined> => {
    const set = {
      ...(resolved.hasHidden ? { hidden: params.hidden } : {}),
      ...(resolved.hasLastErrorCategory || (resolved.status && resolved.status !== 'error')
        ? { lastErrorCategory: resolved.lastErrorCategory }
        : {}),
      ...(resolved.hasMaterializedAgent ? { materializedAgentId: params.materializedAgentId } : {}),
      ...(resolved.status ? { status: resolved.status } : {}),
      lastSyncedAt: new Date(),
      platformAgentVersionChecksum: params.platformAgentVersionChecksum,
      platformAgentVersionId: params.platformAgentVersionId,
      updatedAt: new Date(),
    };
    const stableMaterializedAgentId = !resolved.hasMaterializedAgent
      ? undefined
      : typeof params.materializedAgentId === 'string'
        ? or(
            isNull(platformUserAgentMaterializations.materializedAgentId),
            eq(platformUserAgentMaterializations.materializedAgentId, params.materializedAgentId),
          )
        : isNull(platformUserAgentMaterializations.materializedAgentId);
    const [updated] = await tx
      .update(platformUserAgentMaterializations)
      .set(set)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, params.userId),
          eq(platformUserAgentMaterializations.platformAgentId, params.platformAgentId),
          eq(
            platformUserAgentMaterializations.platformAgentVersionId,
            params.expectedCurrent.versionId,
          ),
          eq(
            platformUserAgentMaterializations.platformAgentVersionChecksum,
            params.expectedCurrent.checksum,
          ),
          stableMaterializedAgentId,
        ),
      )
      .returning();
    if (updated) return updated;
    const existing = await scoped.getMaterialization(params.userId, params.platformAgentId);
    return existing && matchesDesiredState(existing, params, resolved) ? existing : undefined;
  };
}
