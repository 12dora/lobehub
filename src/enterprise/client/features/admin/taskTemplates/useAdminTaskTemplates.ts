'use client';

import { mutate } from 'swr';

import { adminTaskTemplatesService } from '@/enterprise/client/services/adminTaskTemplates';
import { useClientDataSWR } from '@/libs/swr';

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
  const pages = await mutate<AdminTaskTemplateListOutput>(
    (key) => Array.isArray(key) && key[0] === ADMIN_TASK_TEMPLATE_LIST_KEY,
  );
  return (Array.isArray(pages) ? pages : [])
    .filter((page): page is AdminTaskTemplateListOutput => Boolean(page))
    .flatMap((page) => page.items);
};
