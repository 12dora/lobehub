import type { AdminAgentTemplateListQuery } from './types';

export const ADMIN_AGENT_TEMPLATE_LIST_KEY = 'admin.agentTemplates.list' as const;

export const buildAdminAgentTemplateListKey = (input: AdminAgentTemplateListQuery) =>
  [
    ADMIN_AGENT_TEMPLATE_LIST_KEY,
    input.enabled ?? '',
    input.limit,
    input.offset,
    input.query ?? '',
  ] as const;
