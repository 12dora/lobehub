/**
 * PR-049 (ordinary-user managed-Agent source + hide/visibility) is DEFERRED and NOT wired into
 * production. These are pure, tested helpers only — there is no production caller, no runtime/list
 * integration, and no hidden-state mutation. Do not connect them to the user Agent list here; that
 * work lands with PR-049. A regression guard (pr049Deferred.test.ts) asserts the no-caller status.
 */
export const PR049_MANAGED_AGENT_STATUS = 'deferred' as const;

export { PlatformAgentManagementNotice } from './PlatformAgentManagementNotice';
export type { PlatformAgentPresentation } from './presentation';
export { getPlatformAgentPresentation } from './presentation';
