import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

import { platformResourceRevisions } from '@/database/schemas';
import type { PlatformResourceType } from '@/database/schemas/platform/common';
import type { LobeChatDatabase } from '@/database/type';

export interface DeletePlatformResourceRevisionsForTestOptions {
  /**
   * Prefer when the suite owns known resource ids (SG-07). Empty array is a **no-op**
   * (never a full-table delete). Mutually exclusive with `where`.
   */
  resourceIds?: readonly string[];
  /**
   * Optional co-filter with `resourceIds`. Required when multiple resource types share the same
   * id (settings / branding / managed_policy all use `global`).
   */
  resourceType?: PlatformResourceType;
  /**
   * Explicit SQL filter. Mutually exclusive with `resourceIds` — combining both is rejected
   * (including empty arrays) so callers cannot accidentally widen the delete.
   */
  where?: SQL;
}

/**
 * Test-only delete of `platform_resource_revisions`.
 *
 * Production trigger `prevent_platform_resource_revision_mutation` rejects DELETE unless the
 * transaction opts in via `lobe.allow_platform_revision_purge` (migration 0012) — an opt-in
 * reserved for the AI-provider hard-delete purge, which is scoped to one provider. Test
 * teardown deletes across arbitrary resource types, so it keeps the established fixture
 * pattern instead: `SET LOCAL session_replication_role = replica` inside a transaction, so
 * user triggers are skipped for teardown only.
 *
 * **Portability:** `session_replication_role` requires superuser (or equivalent) on real
 * Postgres. This is a pre-existing repo assumption (identityProvider, connectorCatalog,
 * secretRewrap, settings.audit, etc.). If the CI test role is not superuser, server-mode
 * (`TEST_SERVER_DB=1`) teardowns that use this helper will fail.
 */
export const deletePlatformResourceRevisionsForTest = async (
  db: LobeChatDatabase,
  options: DeletePlatformResourceRevisionsForTestOptions = {},
): Promise<void> => {
  const hasResourceIdsOption = options.resourceIds !== undefined;
  const hasWhere = options.where !== undefined;

  if (hasResourceIdsOption && hasWhere) {
    throw new Error(
      'deletePlatformResourceRevisionsForTest: pass either resourceIds or where, not both',
    );
  }

  // Empty resource id list must never widen to a full-table wipe.
  if (hasResourceIdsOption && options.resourceIds!.length === 0) {
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    if (hasResourceIdsOption) {
      const idFilter = inArray(platformResourceRevisions.resourceId, [...options.resourceIds!]);
      const filter = options.resourceType
        ? and(eq(platformResourceRevisions.resourceType, options.resourceType), idFilter)
        : idFilter;
      await tx.delete(platformResourceRevisions).where(filter!);
      return;
    }
    if (hasWhere) {
      await tx.delete(platformResourceRevisions).where(options.where!);
      return;
    }
    await tx.delete(platformResourceRevisions);
  });
};
