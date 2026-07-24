export const ADMIN_AGENT_LIST_KEY = 'enterprise.admin.agents.list';
export const ADMIN_AGENT_GET_KEY = 'enterprise.admin.agents.get';
export const ADMIN_AGENT_ROLLOUT_POLL_KEY = 'enterprise.admin.agents.rollout-poll';

export const buildAdminAgentGetKey = (
  id: string | undefined,
  enabled: boolean,
  rolloutsEnabled = false,
) => (enabled && id ? ([ADMIN_AGENT_GET_KEY, id, rolloutsEnabled] as const) : null);

export const buildAdminAgentRolloutPollKey = (
  agentId: string | undefined,
  activeJobIds: string[],
) =>
  agentId && activeJobIds.length > 0
    ? ([ADMIN_AGENT_ROLLOUT_POLL_KEY, agentId, activeJobIds] as const)
    : null;
