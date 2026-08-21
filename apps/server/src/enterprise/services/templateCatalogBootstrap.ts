import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { DEFAULT_LANG } from '@/const/locale';
import type { PlatformTemplateCatalogDomain } from '@/database/models/platform';
import {
  PlatformAgentTemplateModel,
  PlatformTaskTemplateModel,
  PlatformTemplateCatalogStateModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  fetchBuiltInAgentTemplatesForImport,
  toAgentTemplateAuditDiff,
} from '../routers/admin/agentTemplatesSupport';
import {
  fetchLibraryTaskTemplatesForImport,
  toTaskTemplateAuditDiff,
} from '../routers/admin/taskTemplatesSupport';
import { PlatformAuditService } from './platformAudit';

const CATALOG_SEED_LOCK_NAMESPACE = 'aihub:platform-template-catalog-seed:v1';
const BOOTSTRAP_ACTOR = 'platform-bootstrap';

export interface EnsureTemplateCatalogSeededParams {
  actorUserId?: string | null;
  locale?: string;
}

const resolveSeedLocale = (locale?: string): string => {
  const explicit = locale?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.DEFAULT_LANG?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_LANG;
};

const catalogLockKey = (domain: PlatformTemplateCatalogDomain) =>
  `${CATALOG_SEED_LOCK_NAMESPACE}:${domain}`;

const ensureCatalogSeeded = async (params: {
  db: LobeChatDatabase;
  domain: PlatformTemplateCatalogDomain;
  actorUserId?: string | null;
  locale?: string;
  seedEmpty: (
    tx: Transaction,
    seeded: { actorUserId: string | null; locale: string },
  ) => Promise<void>;
}): Promise<void> => {
  const locale = resolveSeedLocale(params.locale);
  const actorUserId = params.actorUserId ?? null;
  const state = new PlatformTemplateCatalogStateModel(params.db);
  if (await state.findSeeded(params.domain)) return;

  await params.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${catalogLockKey(params.domain)})::bigint)`,
    );

    const lockedState = new PlatformTemplateCatalogStateModel(tx);
    if (await lockedState.findSeeded(params.domain)) return;

    const countModel =
      params.domain === 'agent_templates'
        ? new PlatformAgentTemplateModel(tx)
        : new PlatformTaskTemplateModel(tx);
    const count = await countModel.count();

    if (count === 0) {
      await params.seedEmpty(tx, { actorUserId, locale });
    }

    await lockedState.markSeeded({
      domain: params.domain,
      seededBy: actorUserId,
      seededLocale: locale,
    });
  });
};

/**
 * Load built-in agent templates as real rows the first time the catalog is empty
 * and unseeded. Concurrent callers serialize on a catalog-level advisory lock.
 * Already-populated tenants get a marker only — content is never overwritten.
 */
export const ensureAgentTemplateCatalogSeeded = async (
  db: LobeChatDatabase,
  params: EnsureTemplateCatalogSeededParams = {},
): Promise<void> =>
  ensureCatalogSeeded({
    actorUserId: params.actorUserId,
    db,
    domain: 'agent_templates',
    locale: params.locale,
    seedEmpty: async (tx, seeded) => {
      const fetched = fetchBuiltInAgentTemplatesForImport({ locale: seeded.locale });
      const model = new PlatformAgentTemplateModel(tx);
      const { changes, created, updated } = await model.importByIdentifier({
        actorUserId: seeded.actorUserId,
        nextId: () => randomUUID(),
        rows: fetched.rows,
      });

      await new PlatformAuditService(tx).append({
        action: 'admin.agentTemplates.importBuiltins',
        actorUserId: seeded.actorUserId,
        afterDiff: {
          created,
          reason: 'auto_seed',
          rows: changes.map((change) => ({
            identifier: change.identifier,
            inserted: change.inserted,
            ...(change.after ? toAgentTemplateAuditDiff(change.after) : {}),
          })),
          skipped: fetched.skipped,
          updated,
        },
        beforeDiff: {
          rows: changes
            .filter((change) => change.before)
            .map((change) => ({
              identifier: change.identifier,
              ...toAgentTemplateAuditDiff(change.before!),
            })),
        },
        result: 'success',
        targetId: 'builtins',
        targetType: 'agent_template',
      });
    },
  });

/**
 * Load bundled task-template library rows the first time the catalog is empty
 * and unseeded. Same lock / marker / already-managed semantics as agent templates.
 */
export const ensureTaskTemplateCatalogSeeded = async (
  db: LobeChatDatabase,
  params: EnsureTemplateCatalogSeededParams = {},
): Promise<void> =>
  ensureCatalogSeeded({
    actorUserId: params.actorUserId,
    db,
    domain: 'task_templates',
    locale: params.locale,
    seedEmpty: async (tx, seeded) => {
      const fetched = await fetchLibraryTaskTemplatesForImport({
        locale: seeded.locale,
        userId: seeded.actorUserId ?? BOOTSTRAP_ACTOR,
      });
      const model = new PlatformTaskTemplateModel(tx);
      const { changes, created, updated } = await model.importByIdentifier({
        actorUserId: seeded.actorUserId,
        nextId: () => randomUUID(),
        rows: fetched.rows,
      });

      await new PlatformAuditService(tx).append({
        action: 'admin.taskTemplates.importRecommendations',
        actorUserId: seeded.actorUserId,
        afterDiff: {
          created,
          reason: 'auto_seed',
          rows: changes.map((change) => ({
            identifier: change.identifier,
            inserted: change.inserted,
            ...(change.after ? toTaskTemplateAuditDiff(change.after) : {}),
          })),
          skipped: fetched.skipped,
          updated,
        },
        beforeDiff: {
          rows: changes
            .filter((change) => change.before)
            .map((change) => ({
              identifier: change.identifier,
              ...toTaskTemplateAuditDiff(change.before!),
            })),
        },
        result: 'success',
        targetId: 'library',
        targetType: 'task_template',
      });
    },
  });
