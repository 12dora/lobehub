'use client';

import { adminTaskTemplatesService } from '@/enterprise/client/services/adminTaskTemplates';

import type { AdminTaskTemplateItem, AdminTaskTemplateListOutput } from './types';

/**
 * Outcome of re-reading one row after a revision conflict.
 *
 * `unverified` is a first-class answer rather than an error: telling an operator their row was
 * deleted when the read merely failed — or could not see far enough — pushes them to throw an
 * unsaved draft away and retype it. Only say "deleted" when the read could actually have seen it.
 */
export type TaskTemplateReloadResult =
  | { item: AdminTaskTemplateItem; status: 'found' }
  | { status: 'deleted' }
  | { status: 'unverified' };

/** Rows one recovery read may scan — the admin list contract's own ceiling. */
export const TASK_TEMPLATE_RECOVERY_SCAN_LIMIT = 100;

export type TaskTemplateListReader = (input: {
  limit: number;
  offset: number;
  query: string;
}) => Promise<AdminTaskTemplateListOutput>;

/**
 * Authoritative re-read of a single row, straight from the server.
 *
 * Deliberately *not* derived from the SWR cache refresh: a matcher mutation resolves out of the
 * cache (so a failed revalidation still yields the stale rows), and the admin table's pages are
 * filtered and paginated (so a row that still exists can be absent from them). Recovering from
 * either would reopen the editor on the dead revision or claim the row was deleted.
 *
 * There is no `admin.taskTemplates.getById` procedure, so this searches by `identifier`, which is
 * unique and immutable — the update contract carries no `identifier` field — while the server's
 * `query` filter is an ILIKE-contains over title / identifier / description. An exact-identifier
 * search therefore always contains this row for as long as it exists. No `enabled` filter is sent:
 * a row the winning write hid must still be recoverable.
 */
export const reloadTaskTemplate = async (
  stale: AdminTaskTemplateItem,
  list: TaskTemplateListReader = (input) => adminTaskTemplatesService.list(input),
): Promise<TaskTemplateReloadResult> => {
  let page: AdminTaskTemplateListOutput;
  try {
    page = await list({
      limit: TASK_TEMPLATE_RECOVERY_SCAN_LIMIT,
      offset: 0,
      query: stale.identifier,
    });
  } catch {
    return { status: 'unverified' };
  }

  const found = page.items.find((row) => row.id === stale.id);
  if (found) return { item: found, status: 'found' };

  // Absence only proves deletion when the read was not truncated; otherwise the row may simply
  // sit past the scanned window and "deleted" would be a guess.
  if (page.totalFiltered > page.items.length) return { status: 'unverified' };

  return { status: 'deleted' };
};
