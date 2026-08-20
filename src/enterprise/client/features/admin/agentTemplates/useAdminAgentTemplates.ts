'use client';

import { PLATFORM_AGENT_TEMPLATES_KEY } from '@/enterprise/client/hooks/usePlatformAgentTemplates';
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
 * Revalidate every cached list page **and** the user-facing list this console shares a tab with.
 *
 * The operator is also a user: their own create-agent modal caches `platform.agentTemplates.list`
 * under {@link PLATFORM_AGENT_TEMPLATES_KEY}, so an admin write that only refreshed the admin
 * table would leave that modal serving the pre-edit examples for the rest of the session.
 *
 * @returns the refreshed **admin** rows, so a caller recovering from a revision conflict can pick
 *   the current server state of one row without a second round trip.
 */
export const refreshAdminAgentTemplateLists = async (): Promise<AdminAgentTemplateItem[]> => {
  const [pages] = await Promise.all([
    mutate<AdminAgentTemplateListOutput>(
      (key) => Array.isArray(key) && key[0] === ADMIN_AGENT_TEMPLATE_LIST_KEY,
    ),
    mutate((key) => Array.isArray(key) && key[0] === PLATFORM_AGENT_TEMPLATES_KEY),
  ]);
  return (Array.isArray(pages) ? pages : [])
    .filter((page): page is AdminAgentTemplateListOutput => Boolean(page))
    .flatMap((page) => page.items);
};
