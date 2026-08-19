import { sql } from 'drizzle-orm';

import type { LobeChatDatabase, Transaction } from '../../type';

export const publishedPoliciesJsonAggSql = () => sql`
  COALESCE(
    (
      SELECT json_agg(row_to_json(p))
      FROM (
        SELECT
          "path",
          "mode",
          "visibility",
          "value",
          "schema_version" AS "schemaVersion",
          "revision",
          "status",
          "updated_by" AS "updatedBy",
          "created_at" AS "createdAt",
          "updated_at" AS "updatedAt"
        FROM "platform_setting_policies"
        WHERE "status" = 'published'
      ) p
    ),
    '[]'::json
  )
`;

export const platformRevisionSql = (bundleId: string) => sql`
  COALESCE(
    (
      SELECT "revision"
      FROM "platform_settings_bundle"
      WHERE "id" = ${bundleId}
    ),
    0
  )
`;

export const userOverrideRevisionSql = (userId: string) => sql`
  COALESCE(
    (
      SELECT "revision"
      FROM "user_setting_override_revisions"
      WHERE "user_id" = ${userId}
    ),
    0
  )
`;

export const overrideRowsJsonAggSql = (userId: string) => sql`
  COALESCE(
    (
      SELECT json_agg(row_to_json(o))
      FROM (
        SELECT
          "user_id" AS "userId",
          "path",
          "value",
          "source",
          "updated_at" AS "updatedAt"
        FROM "user_setting_overrides"
        WHERE "user_id" = ${userId}
      ) o
    ),
    '[]'::json
  )
`;

export const readExecuteRows = <T>(result: unknown): T[] => {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
};

export const runInSettingsTx = async <T>(
  db: LobeChatDatabase | Transaction,
  alreadyInTransaction: boolean | undefined,
  run: (db: LobeChatDatabase | Transaction) => Promise<T>,
): Promise<T> => {
  if (alreadyInTransaction || !('transaction' in db)) {
    return run(db);
  }
  return (db as LobeChatDatabase).transaction(async (tx) => run(tx));
};
