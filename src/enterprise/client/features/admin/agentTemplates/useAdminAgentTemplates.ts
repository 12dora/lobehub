'use client';

import { PLATFORM_AGENT_TEMPLATES_KEY } from '@/enterprise/client/hooks/usePlatformAgentTemplates';
import { adminAgentTemplatesService } from '@/enterprise/client/services/adminAgentTemplates';
import { mutate, useClientDataSWR } from '@/libs/swr';

import { ADMIN_AGENT_TEMPLATE_LIST_KEY, buildAdminAgentTemplateListKey } from './swrKeys';
import type { AdminAgentTemplateListOutput, AdminAgentTemplateListQuery } from './types';

export const useFetchAdminAgentTemplates = (input: AdminAgentTemplateListQuery, enabled = true) =>
  useClientDataSWR<AdminAgentTemplateListOutput>(
    enabled ? buildAdminAgentTemplateListKey(input) : null,
    () => adminAgentTemplatesService.list(input),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

/**
 * Drop every cached page of this catalog — the admin table's own pages **and** the user-facing
 * list the operator shares this browser session with.
 *
 * Eviction (`undefined` + `revalidate`), not a bare `mutate(predicate)`: a predicate-only mutate
 * only reaches *mounted* subscribers, and `platform.agentTemplates.list` — read by the create-agent modal — is
 * unmounted the whole time the operator is on an admin page. Its entry would keep the pre-edit
 * rows and hand them straight back on the next mount, before any revalidation could land. Clearing
 * the entry makes that mount start from "unknown" and fetch.
 *
 * The admin table does not flash: `useFetchAdminAgentTemplates` sets `keepPreviousData: true`, so
 * SWR keeps the last non-undefined page on screen while the refetch is in flight.
 *
 * Returns nothing on purpose. A cache round trip is not an authoritative read — SWR resolves
 * matcher mutations out of the cache, and any single admin page is filtered and paginated — so
 * conflict recovery has to re-read its row itself (see `reloadAgentTemplate`).
 */
export const refreshAdminAgentTemplateLists = async (): Promise<void> => {
  const evict = (prefix: string) =>
    mutate((key) => Array.isArray(key) && key[0] === prefix, undefined, { revalidate: true });

  await Promise.all([evict(ADMIN_AGENT_TEMPLATE_LIST_KEY), evict(PLATFORM_AGENT_TEMPLATES_KEY)]);
};
