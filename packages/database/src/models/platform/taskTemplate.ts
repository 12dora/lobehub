import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import { likeContains } from '../../repositories/platformSearch';
import type { PlatformTaskTemplateConnector } from '../../schemas/platform';
import { platformTaskTemplates } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import {
  PLATFORM_TEMPLATE_CATALOG_LEGACY_LOCALE,
  PlatformTemplateCatalogStateModel,
  withPlatformTemplateCatalogLock,
} from './templateCatalogState';

const TASK_TEMPLATE_CATALOG_DOMAIN = 'task_templates' as const;

/** Namespace for per-identifier import locks (`hashtext` key of `${ns}:${identifier}`). */
const TASK_TEMPLATE_IMPORT_LOCK_NAMESPACE = 'aihub:platform-task-templates-import:v1';

export interface PlatformTaskTemplateRecord {
  category: string;
  connectors: PlatformTaskTemplateConnector[];
  createdAt: Date;
  cronPattern: string;
  description: string;
  enabled: boolean;
  icon: string | null;
  id: string;
  identifier: string;
  instruction: string;
  interests: string[];
  revision: number;
  sortOrder: number;
  source: string;
  title: string;
  updatedAt: Date;
}

/**
 * Editable content of a task template.
 * `sortOrder` is deliberately absent: display order is owned by drag-and-drop
 * ({@link PlatformTaskTemplateModel.reorder}), not by the editor form.
 */
export interface PlatformTaskTemplateDocument {
  category: string;
  connectors: PlatformTaskTemplateConnector[];
  cronPattern: string;
  description: string;
  enabled: boolean;
  icon: string | null;
  instruction: string;
  interests: string[];
  title: string;
}

export interface PlatformTaskTemplateListParams {
  enabled?: boolean;
  /**
   * Extra identifier matches ORed into the query filter so a locale overlay can find rows whose
   * stored title/description no longer contain the operator's search string.
   * Absent or empty: existing text filter only.
   */
  identifiers?: string[];
  limit: number;
  offset: number;
  query?: string;
}

export type PlatformTaskTemplateCountParams = Pick<
  PlatformTaskTemplateListParams,
  'enabled' | 'identifiers' | 'query'
>;

export interface PlatformTaskTemplateListResult {
  items: PlatformTaskTemplateRecord[];
  total: number;
}

/** What one imported identifier replaced and produced — the import's audit evidence. */
export interface PlatformTaskTemplateImportChange {
  after?: PlatformTaskTemplateRecord;
  /** Absent for a freshly created row (there was nothing to replace). */
  before?: PlatformTaskTemplateRecord;
  identifier: string;
  inserted: boolean;
}

/** Upsert payload for 从推荐库导入 — enabled / sortOrder of existing rows are preserved. */
export interface PlatformTaskTemplateImportRow {
  category: string;
  connectors: PlatformTaskTemplateConnector[];
  cronPattern: string;
  description: string;
  icon: string | null;
  identifier: string;
  instruction: string;
  interests: string[];
  title: string;
}

/** Raised when `platform_task_templates_identifier_unique` rejects a write. */
export class PlatformTaskTemplateIdentifierConflictError extends Error {
  readonly code = 'PLATFORM_TASK_TEMPLATE_IDENTIFIER_CONFLICT' as const;

  constructor(public readonly identifier: string) {
    super(`Task template identifier already exists: ${identifier}`);
    this.name = 'PlatformTaskTemplateIdentifierConflictError';
  }
}

/** Postgres `unique_violation`, unwrapped from the layers drizzle/pg wrap it in. */
const isUniqueViolation = (error: unknown): boolean => {
  const candidates: unknown[] = [error];
  if (error && typeof error === 'object') {
    const nested = error as { cause?: unknown };
    if (nested.cause) candidates.push(nested.cause);
    if (nested.cause && typeof nested.cause === 'object' && 'cause' in nested.cause) {
      candidates.push((nested.cause as { cause?: unknown }).cause);
    }
  }
  return candidates.some((candidate) => {
    if (!candidate || typeof candidate !== 'object' || !('code' in candidate)) return false;
    return String((candidate as { code?: unknown }).code) === '23505';
  });
};

const listWhere = (params: PlatformTaskTemplateCountParams): SQL | undefined => {
  const filters: SQL[] = [];
  if (params.enabled !== undefined) {
    filters.push(eq(platformTaskTemplates.enabled, params.enabled));
  }
  const trimmed = params.query?.trim();
  const identifierMatch =
    params.identifiers && params.identifiers.length > 0
      ? inArray(platformTaskTemplates.identifier, params.identifiers)
      : undefined;
  if (trimmed) {
    const pattern = likeContains(trimmed);
    const textMatch = or(
      ilike(platformTaskTemplates.title, pattern),
      ilike(platformTaskTemplates.identifier, pattern),
      ilike(platformTaskTemplates.description, pattern),
    );
    const matched = identifierMatch ? or(textMatch, identifierMatch) : textMatch;
    if (matched) filters.push(matched);
  } else if (identifierMatch) {
    filters.push(identifierMatch);
  }
  return filters.length > 0 ? and(...filters) : undefined;
};

const toRecord = (row: typeof platformTaskTemplates.$inferSelect): PlatformTaskTemplateRecord => ({
  category: row.category,
  connectors: row.connectors ?? [],
  createdAt: row.createdAt,
  cronPattern: row.cronPattern,
  description: row.description,
  enabled: row.enabled,
  icon: row.icon ?? null,
  id: row.id,
  identifier: row.identifier,
  instruction: row.instruction,
  interests: row.interests ?? [],
  revision: row.revision,
  sortOrder: row.sortOrder,
  source: row.source,
  title: row.title,
  updatedAt: row.updatedAt,
});

/**
 * Reads and writes {@link platformTaskTemplates}.
 *
 * Ordering is `sortOrder` ascending then `updatedAt` descending everywhere, so the admin
 * table and the user-facing recommendation list never disagree about precedence.
 */
export class PlatformTaskTemplateModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  /**
   * Row count. Called with no args this is the unfiltered catalog size (`totalAll`).
   * The same optional filters as {@link list} (minus pagination) produce a filtered count.
   */
  count = async (params: PlatformTaskTemplateCountParams = {}): Promise<number> => {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(platformTaskTemplates)
      .where(listWhere(params));
    return row?.value ?? 0;
  };

  /**
   * Enabled rows in display order — the user-facing list.
   * `limit` is mandatory: instructions run to thousands of characters and the number of manual
   * rows is unbounded, so this response must never grow with the catalog.
   */
  listEnabled = async (limit: number): Promise<PlatformTaskTemplateRecord[]> => {
    const rows = await this.db
      .select()
      .from(platformTaskTemplates)
      .where(eq(platformTaskTemplates.enabled, true))
      .orderBy(asc(platformTaskTemplates.sortOrder), desc(platformTaskTemplates.updatedAt))
      .limit(Math.max(1, limit));
    return rows.map((row) => toRecord(row));
  };

  list = async (
    params: PlatformTaskTemplateListParams,
  ): Promise<PlatformTaskTemplateListResult> => {
    const where = listWhere(params);

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select()
        .from(platformTaskTemplates)
        .where(where)
        .orderBy(asc(platformTaskTemplates.sortOrder), desc(platformTaskTemplates.updatedAt))
        .limit(params.limit)
        .offset(params.offset),
      this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(platformTaskTemplates)
        .where(where),
    ]);

    return { items: rows.map((row) => toRecord(row)), total: totalRow?.value ?? 0 };
  };

  findById = async (id: string): Promise<PlatformTaskTemplateRecord | undefined> => {
    const [row] = await this.db
      .select()
      .from(platformTaskTemplates)
      .where(eq(platformTaskTemplates.id, id))
      .limit(1);
    return row ? toRecord(row) : undefined;
  };

  /** Slot for a row appended to the end of the list. */
  nextSortOrder = async (): Promise<number> => {
    const [row] = await this.db
      .select({ value: sql<number | null>`max(${platformTaskTemplates.sortOrder})` })
      .from(platformTaskTemplates);
    return (row?.value ?? -1) + 1;
  };

  create = async (params: {
    actorUserId: string | null;
    document: PlatformTaskTemplateDocument;
    id: string;
    identifier: string;
    source: 'manual' | 'market';
    /** Defaults to the end of the list — new rows never jump the queue. */
    sortOrder?: number;
  }): Promise<PlatformTaskTemplateRecord> =>
    withPlatformTemplateCatalogLock(this.db, TASK_TEMPLATE_CATALOG_DOMAIN, async (tx) => {
      const inner = new PlatformTaskTemplateModel(tx);
      const sortOrder = params.sortOrder ?? (await inner.nextSortOrder());
      let row: typeof platformTaskTemplates.$inferSelect | undefined;
      try {
        [row] = await tx
          .insert(platformTaskTemplates)
          .values({
            ...params.document,
            id: params.id,
            identifier: params.identifier,
            revision: 1,
            sortOrder,
            source: params.source,
            updatedBy: params.actorUserId,
          })
          .returning();
      } catch (error) {
        // A taken identifier is an ordinary input conflict, not an internal failure.
        if (isUniqueViolation(error)) {
          throw new PlatformTaskTemplateIdentifierConflictError(params.identifier);
        }
        throw error;
      }
      if (!row) throw new Error('Failed to insert platform task template');
      await inner.claimCatalog(params.actorUserId);
      return toRecord(row);
    });

  /**
   * Conditional content update.
   * @throws PlatformRevisionConflictError when `expectedRevision` no longer matches.
   */
  update = async (params: {
    actorUserId: string | null;
    document: PlatformTaskTemplateDocument;
    expectedRevision: number;
    id: string;
  }): Promise<PlatformTaskTemplateRecord> =>
    withPlatformTemplateCatalogLock(this.db, TASK_TEMPLATE_CATALOG_DOMAIN, async (tx) => {
      const inner = new PlatformTaskTemplateModel(tx);
      const [row] = await tx
        .update(platformTaskTemplates)
        .set({
          ...params.document,
          revision: params.expectedRevision + 1,
          updatedAt: new Date(),
          updatedBy: params.actorUserId,
        })
        .where(
          and(
            eq(platformTaskTemplates.id, params.id),
            eq(platformTaskTemplates.revision, params.expectedRevision),
          ),
        )
        .returning();

      if (!row) {
        const current = await inner.findById(params.id);
        throw new PlatformRevisionConflictError(
          'Task template revision conflict: expectedRevision does not match current revision',
          {
            currentRevision: current?.revision ?? -1,
            expectedRevision: params.expectedRevision,
            resourceId: params.id,
            resourceType: 'task_template',
          },
        );
      }
      await inner.claimCatalog(params.actorUserId);
      return toRecord(row);
    });

  /**
   * Enable / disable a single row under the same per-row CAS as a full edit: a table left open
   * next to another administrator's edit must not silently republish stale intent.
   * @returns undefined when the row no longer exists (404)
   * @throws PlatformRevisionConflictError when the row moved on (409)
   */
  setEnabled = async (params: {
    actorUserId: string | null;
    enabled: boolean;
    expectedRevision: number;
    id: string;
  }): Promise<PlatformTaskTemplateRecord | undefined> =>
    withPlatformTemplateCatalogLock(this.db, TASK_TEMPLATE_CATALOG_DOMAIN, async (tx) => {
      const inner = new PlatformTaskTemplateModel(tx);
      const [row] = await tx
        .update(platformTaskTemplates)
        .set({
          enabled: params.enabled,
          revision: params.expectedRevision + 1,
          updatedAt: new Date(),
          updatedBy: params.actorUserId,
        })
        .where(
          and(
            eq(platformTaskTemplates.id, params.id),
            eq(platformTaskTemplates.revision, params.expectedRevision),
          ),
        )
        .returning();

      if (row) {
        await inner.claimCatalog(params.actorUserId);
        return toRecord(row);
      }
      return inner.rejectStale(params.id, params.expectedRevision);
    });

  /**
   * Hard delete under the same per-row CAS.
   * @returns undefined when the row is already gone (404)
   * @throws PlatformRevisionConflictError when the row moved on (409)
   */
  delete = async (params: {
    expectedRevision: number;
    id: string;
  }): Promise<PlatformTaskTemplateRecord | undefined> =>
    withPlatformTemplateCatalogLock(this.db, TASK_TEMPLATE_CATALOG_DOMAIN, async (tx) => {
      const inner = new PlatformTaskTemplateModel(tx);
      const [row] = await tx
        .delete(platformTaskTemplates)
        .where(
          and(
            eq(platformTaskTemplates.id, params.id),
            eq(platformTaskTemplates.revision, params.expectedRevision),
          ),
        )
        .returning();

      if (row) {
        await inner.claimCatalog(null);
        return toRecord(row);
      }
      return inner.rejectStale(params.id, params.expectedRevision);
    });

  /**
   * Apply a new display order to a set of rows.
   *
   * The rows keep the `sortOrder` **slots they already occupy**: the occupied values are sorted
   * ascending and handed out in the requested id order. Reordering one page of the admin table
   * therefore never disturbs rows on another page, and no global renumbering is needed.
   *
   * Every row is locked and CAS-checked first, so a drag performed against a stale table is
   * rejected as a whole instead of half-applied.
   *
   * @throws PlatformRevisionConflictError when any row moved on
   * @returns undefined when any id no longer exists (404)
   */
  reorder = async (params: {
    actorUserId: string | null;
    items: { expectedRevision: number; id: string }[];
  }): Promise<PlatformTaskTemplateRecord[] | undefined> =>
    withPlatformTemplateCatalogLock(this.db, TASK_TEMPLATE_CATALOG_DOMAIN, async (tx) => {
      const inner = new PlatformTaskTemplateModel(tx);
      const ids = params.items.map((item) => item.id);
      const locked = await tx
        .select()
        .from(platformTaskTemplates)
        .where(inArray(platformTaskTemplates.id, ids))
        // Deterministic lock order (by id) so two concurrent reorders cannot deadlock.
        .orderBy(asc(platformTaskTemplates.id))
        .for('update');

      if (locked.length !== ids.length) return undefined;

      const byId = new Map(locked.map((row) => [row.id, row]));
      for (const item of params.items) {
        const row = byId.get(item.id);
        if (row && row.revision !== item.expectedRevision) {
          throw new PlatformRevisionConflictError(
            'Task template revision conflict: the list changed before this reorder was applied',
            {
              currentRevision: row.revision,
              expectedRevision: item.expectedRevision,
              resourceId: item.id,
              resourceType: 'task_template',
            },
          );
        }
      }

      // Rows written before drag ordering existed can share slot 0, so force the reused slots to be
      // strictly increasing — otherwise the "new" order would collapse back onto one value.
      // Accumulates over the running previous slot, not the original array.
      const slots: number[] = [];
      for (const slot of locked.map((row) => row.sortOrder).sort((a, b) => a - b)) {
        const previous = slots.at(-1);
        slots.push(previous === undefined ? slot : Math.max(slot, previous + 1));
      }
      const updatedAt = new Date();
      const results: PlatformTaskTemplateRecord[] = [];

      for (const [index, item] of params.items.entries()) {
        const [row] = await tx
          .update(platformTaskTemplates)
          .set({
            revision: item.expectedRevision + 1,
            sortOrder: slots[index]!,
            updatedAt,
            updatedBy: params.actorUserId,
          })
          .where(eq(platformTaskTemplates.id, item.id))
          .returning();
        if (!row) return undefined;
        results.push(toRecord(row));
      }

      await inner.claimCatalog(params.actorUserId);
      return results;
    });

  /** A conditional write that matched nothing is either a missing row or a stale revision. */
  private rejectStale = async (id: string, expectedRevision: number): Promise<undefined> => {
    const current = await this.findById(id);
    if (!current) return undefined;
    throw new PlatformRevisionConflictError(
      'Task template revision conflict: expectedRevision does not match current revision',
      {
        currentRevision: current.revision,
        expectedRevision,
        resourceId: id,
        resourceType: 'task_template',
      },
    );
  };

  /**
   * Idempotent import by `identifier`.
   *
   * Default `onConflict: 'update'` is the operator import: content columns are overwritten while
   * `enabled` / `sortOrder` on an existing row are preserved. Auto-seed uses `'nothing'` so a
   * concurrent create/import cannot have its localized content replaced.
   *
   * Catalog lock is acquired first (via {@link withPlatformTemplateCatalogLock}); per-identifier
   * advisory locks stay next so first-time importers still serialize the audit `before` read.
   */
  importByIdentifier = async (params: {
    actorUserId: string | null;
    nextId: () => string;
    onConflict?: 'update' | 'nothing';
    rows: PlatformTaskTemplateImportRow[];
    seededLocale?: string;
  }): Promise<{
    changes: PlatformTaskTemplateImportChange[];
    created: number;
    updated: number;
  }> =>
    withPlatformTemplateCatalogLock(this.db, TASK_TEMPLATE_CATALOG_DOMAIN, async (tx) => {
      const inner = new PlatformTaskTemplateModel(tx);
      const changes: PlatformTaskTemplateImportChange[] = [];
      let nextSlot = await inner.nextSortOrder();
      let created = 0;
      let updated = 0;
      const onConflict = params.onConflict ?? 'update';

      for (const row of params.rows) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`${TASK_TEMPLATE_IMPORT_LOCK_NAMESPACE}:${row.identifier}`})::bigint)`,
        );
        const [locked] = await tx
          .select()
          .from(platformTaskTemplates)
          .where(eq(platformTaskTemplates.identifier, row.identifier))
          .limit(1)
          .for('update');
        const before = locked ? toRecord(locked) : undefined;

        const values = {
          category: row.category,
          connectors: row.connectors,
          cronPattern: row.cronPattern,
          description: row.description,
          enabled: true,
          icon: row.icon,
          id: params.nextId(),
          identifier: row.identifier,
          instruction: row.instruction,
          interests: row.interests,
          revision: 1,
          sortOrder: nextSlot,
          source: 'market' as const,
          title: row.title,
          updatedBy: params.actorUserId,
        };
        const returning = {
          ...getTableColumns(platformTaskTemplates),
          inserted: sql<boolean>`(xmax = 0)`,
        };
        const insert = tx.insert(platformTaskTemplates).values(values);
        const [result] =
          onConflict === 'nothing'
            ? await insert
                .onConflictDoNothing({ target: platformTaskTemplates.identifier })
                .returning(returning)
            : await insert
                .onConflictDoUpdate({
                  set: {
                    category: row.category,
                    connectors: row.connectors,
                    cronPattern: row.cronPattern,
                    description: row.description,
                    icon: row.icon,
                    instruction: row.instruction,
                    interests: row.interests,
                    revision: sql`${platformTaskTemplates.revision} + 1`,
                    source: 'market',
                    title: row.title,
                    updatedAt: new Date(),
                    updatedBy: params.actorUserId,
                  },
                  target: platformTaskTemplates.identifier,
                })
                .returning(returning);

        if (!result) {
          changes.push({ after: before, before, identifier: row.identifier, inserted: false });
          continue;
        }

        const inserted = Boolean(result.inserted);
        if (inserted) {
          created += 1;
          nextSlot += 1;
        } else updated += 1;

        changes.push({
          after: toRecord(result),
          before: inserted ? undefined : before,
          identifier: row.identifier,
          inserted,
        });
      }

      await inner.claimCatalog(params.actorUserId, params.seededLocale);
      return { changes, created, updated };
    });

  private claimCatalog = async (actorUserId: string | null, seededLocale?: string) => {
    await new PlatformTemplateCatalogStateModel(this.db).markSeeded({
      domain: TASK_TEMPLATE_CATALOG_DOMAIN,
      seededBy: actorUserId,
      seededLocale: seededLocale ?? PLATFORM_TEMPLATE_CATALOG_LEGACY_LOCALE,
    });
  };
}
