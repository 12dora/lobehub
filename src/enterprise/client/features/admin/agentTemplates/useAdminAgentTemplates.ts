'use client';

import { adminAgentTemplatesService } from '@/enterprise/client/services/adminAgentTemplates';
import { mutate, useClientDataSWR } from '@/libs/swr';

import { ADMIN_AGENT_TEMPLATE_LIST_KEY, buildAdminAgentTemplateListKey } from './swrKeys';
import type {
  AdminAgentTemplateItem,
  AdminAgentTemplateListOutput,
  AdminAgentTemplateListQuery,
} from './types';

export const useFetchAdminAgentTemplates = (input: AdminAgentTemplateListQuery, enabled = true) =>
  useClientDataSWR<AdminAgentTemplateListOutput>(
    enabled ? buildAdminAgentTemplateListKey(input) : null,
    () => adminAgentTemplatesService.list(input),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

/**
 * Revalidate every cached list page.
 * @returns the refreshed rows, so a caller recovering from a revision conflict can pick the
 *   current server state of one row without a second round trip.
 */
export const refreshAdminAgentTemplateLists = async (): Promise<AdminAgentTemplateItem[]> => {
  const pages = await mutate<AdminAgentTemplateListOutput>(
    (key) => Array.isArray(key) && key[0] === ADMIN_AGENT_TEMPLATE_LIST_KEY,
  );
  return (Array.isArray(pages) ? pages : [])
    .filter((page): page is AdminAgentTemplateListOutput => Boolean(page))
    .flatMap((page) => page.items);
};
