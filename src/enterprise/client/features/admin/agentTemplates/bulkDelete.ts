'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import type { AdminAgentTemplateItem } from './types';

/** Failed rows named in the summary toast before it collapses to a count. */
const FAILURE_PREVIEW = 3;

export interface AgentTemplateBulkResult {
  failed: { reason: string; title: string }[];
  succeeded: number;
}

/**
 * Compact translated reason for one failed row. Raw error codes never reach the operator —
 * the three outcomes that actually differ (stale CAS token, row already gone, everything
 * else) each get their own copy.
 */
export const getAgentTemplateBulkFailureKey = (error: unknown): string => {
  const code = mapEnterpriseError(error)?.code;
  if (code === 'PLATFORM_REVISION_CONFLICT') {
    return 'agentTemplateCatalog.bulkDelete.reason.conflict';
  }
  if (code === 'PLATFORM_NOT_FOUND') return 'agentTemplateCatalog.bulkDelete.reason.notFound';
  return 'agentTemplateCatalog.bulkDelete.reason.failed';
};

/**
 * Sequential client-side loop over the single-row `delete` mutation — there is no server
 * bulk procedure, and a partial result is a real outcome the operator must see.
 */
export const runAgentTemplateBulkDelete = async (params: {
  items: readonly AdminAgentTemplateItem[];
  mutate: (item: AdminAgentTemplateItem) => Promise<unknown>;
  t: TFunction<'admin'>;
}): Promise<AgentTemplateBulkResult> => {
  const failed: AgentTemplateBulkResult['failed'] = [];
  let succeeded = 0;

  for (const item of params.items) {
    try {
      await params.mutate(item);
      succeeded += 1;
    } catch (error) {
      failed.push({
        reason: params.t(getAgentTemplateBulkFailureKey(error) as never),
        title: item.title,
      });
    }
  }

  return { failed, succeeded };
};

/** One toast for the whole run: success only when every row went through. */
export const toastAgentTemplateBulkSummary = (
  result: AgentTemplateBulkResult,
  t: TFunction<'admin'>,
) => {
  if (result.failed.length === 0) {
    toast.success(t('agentTemplateCatalog.toast.bulkDeleted', { count: result.succeeded }));
    return;
  }

  const detail = result.failed
    .slice(0, FAILURE_PREVIEW)
    .map((item) =>
      t('agentTemplateCatalog.toast.bulkFailureDetail', {
        reason: item.reason,
        title: item.title,
      }),
    )
    .join(' · ');

  toast.warning(
    `${t('agentTemplateCatalog.toast.bulkSummary', {
      failed: result.failed.length,
      succeeded: result.succeeded,
    })}${detail ? ` — ${detail}` : ''}`,
  );
};
