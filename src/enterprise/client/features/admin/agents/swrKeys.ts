import type { AdminAgentListInput } from './types';

export const ADMIN_AGENT_LIST_KEY = 'enterprise.admin.agents.list';
export const ADMIN_AGENT_GET_KEY = 'enterprise.admin.agents.get';

export const buildAdminAgentListKey = (input: AdminAgentListInput, enabled: boolean) =>
  enabled ? ([ADMIN_AGENT_LIST_KEY, input] as const) : null;

export const buildAdminAgentGetKey = (id: string | undefined, enabled: boolean) =>
  enabled && id ? ([ADMIN_AGENT_GET_KEY, id] as const) : null;
