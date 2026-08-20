import type { AdminAgentTemplateListQuery } from './types';

export const ADMIN_AGENT_TEMPLATE_LIST_KEY = 'admin.agentTemplates.list' as const;

/**
 * `locale` is part of the key: while the catalog is unmanaged the list answers with preview rows
 * of the bundled library rendered in that language, so two locales are two different pages.
 */
export const buildAdminAgentTemplateListKey = (input: AdminAgentTemplateListQuery) =>
  [
    ADMIN_AGENT_TEMPLATE_LIST_KEY,
    input.enabled ?? '',
    input.limit,
    input.locale ?? '',
    input.offset,
    input.query ?? '',
  ] as const;
