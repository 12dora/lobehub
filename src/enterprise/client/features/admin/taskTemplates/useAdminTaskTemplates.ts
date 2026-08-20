'use client';

import { PLATFORM_TASK_TEMPLATES_KEY } from '@/enterprise/client/hooks/usePlatformTaskTemplates';
import { adminTaskTemplatesService } from '@/enterprise/client/services/adminTaskTemplates';
import { mutate, useClientDataSWR } from '@/libs/swr';

import { ADMIN_TASK_TEMPLATE_LIST_KEY, buildAdminTaskTemplateListKey } from './swrKeys';
import type {
  AdminTaskTemplateItem,
  AdminTaskTemplateListOutput,
  AdminTaskTemplateListQuery,
} from './types';

export const useFetchAdminTaskTemplates = (input: AdminTaskTemplateListQuery, enabled = true) =>
  useClientDataSWR<AdminTaskTemplateListOutput>(
    enabled ? buildAdminTaskTemplateListKey(input) : null,
    () => adminTaskTemplatesService.list(input),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

/**
 * Revalidate every cached list page.
 * @returns the refreshed rows, so a caller recovering from a revision conflict can pick the
 *   current server state of one row without a second round trip.
 */
export const refreshAdminTaskTemplateLists = async (): Promise<AdminTaskTemplateItem[]> => {
  // The operator is also a user: invalidate the home recommendations cache too, otherwise an
  // admin write leaves the operator's own `platform.taskTemplates.list` stale for the session.
  const [pages] = await Promise.all([
    mutate<AdminTaskTemplateListOutput>(
      (key) => Array.isArray(key) && key[0] === ADMIN_TASK_TEMPLATE_LIST_KEY,
    ),
    mutate((key) => Array.isArray(key) && key[0] === PLATFORM_TASK_TEMPLATES_KEY),
  ]);
  return (Array.isArray(pages) ? pages : [])
    .filter((page): page is AdminTaskTemplateListOutput => Boolean(page))
    .flatMap((page) => page.items);
};
