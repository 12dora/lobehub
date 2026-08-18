'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import type { AdminTaskTemplateItem } from './types';

/** Failed rows named in the summary toast before it collapses to a count. */
const FAILURE_PREVIEW = 3;

export interface TaskTemplateBulkResult {
  failed: { reason: string; title: string }[];
  succeeded: number;
}

/**
 * Compact translated reason for one failed row. Raw error codes never reach the operator —
 * the three outcomes that actually differ (stale CAS token, row already gone, everything
 * else) each get their own copy.
 */
export const getTaskTemplateBulkFailureKey = (error: unknown): string => {
  const code = mapEnterpriseError(error)?.code;
  if (code === 'PLATFORM_REVISION_CONFLICT') {
    return 'taskTemplateCatalog.bulkDelete.reason.conflict';
  }
  if (code === 'PLATFORM_NOT_FOUND') return 'taskTemplateCatalog.bulkDelete.reason.notFound';
  return 'taskTemplateCatalog.bulkDelete.reason.failed';
};

/**
 * Sequential client-side loop over the single-row `delete` mutation — there is no server
 * bulk procedure, and a partial result is a real outcome the operator must see.
 */
export const runTaskTemplateBulkDelete = async (params: {
  items: readonly AdminTaskTemplateItem[];
  mutate: (item: AdminTaskTemplateItem) => Promise<unknown>;
  t: TFunction<'admin'>;
}): Promise<TaskTemplateBulkResult> => {
  const failed: TaskTemplateBulkResult['failed'] = [];
  let succeeded = 0;

  for (const item of params.items) {
    try {
      await params.mutate(item);
      succeeded += 1;
    } catch (error) {
      failed.push({
        reason: params.t(getTaskTemplateBulkFailureKey(error) as never),
        title: item.title,
      });
    }
  }

  return { failed, succeeded };
};

/** One toast for the whole run: success only when every row went through. */
export const toastTaskTemplateBulkSummary = (
  result: TaskTemplateBulkResult,
  t: TFunction<'admin'>,
) => {
  if (result.failed.length === 0) {
    toast.success(t('taskTemplateCatalog.toast.bulkDeleted', { count: result.succeeded }));
    return;
  }

  const detail = result.failed
    .slice(0, FAILURE_PREVIEW)
    .map((item) =>
      t('taskTemplateCatalog.toast.bulkFailureDetail', {
        reason: item.reason,
        title: item.title,
      }),
    )
    .join(' · ');

  toast.warning(
    `${t('taskTemplateCatalog.toast.bulkSummary', {
      failed: result.failed.length,
      succeeded: result.succeeded,
    })}${detail ? ` — ${detail}` : ''}`,
  );
};
