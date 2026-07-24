import { isDesktop } from '@lobechat/const';
import urlJoin from 'url-join';

import { useQueryRoute } from '@/hooks/useQueryRoute';
import { lambdaQuery } from '@/libs/trpc/client';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

// Fixed cred key — must stay in sync with CloudHeterogeneousConfig
const CLAUDE_TOKEN_CRED_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

interface HeteroAgentCloudConfig {
  goToConfig: () => void;
  isConfigured: boolean;
}

/**
 * Cloud credential readiness for heterogeneous (claude-code) agents.
 * Lives under enterprise; business mount re-exports this hook.
 */
export const useHeteroAgentCloudConfig = (agentId: string): HeteroAgentCloudConfig => {
  const router = useQueryRoute();

  const heterogeneousProvider = useAgentStore(
    (s) => agentByIdSelectors.getAgencyConfigById(agentId)(s)?.heterogeneousProvider,
  );

  // Only claude-code agents require a cloud credential — codex and other providers do not use this key
  const isClaudeCode = heterogeneousProvider?.type === 'claude-code';
  const needsCredCheck = !isDesktop && isClaudeCode;

  // Only fetch credentials when actually needed
  const { data: credsData, isLoading: isCredsLoading } = lambdaQuery.market.creds.list.useQuery(
    undefined,
    { enabled: needsCredCheck },
  );

  // Resolve the vault key the agent points at (env ref) or the fixed default token key.
  // Presence of CLAUDE_CODE_CRED_KEY alone is only a *reference* — not proof the secret still exists.
  const referencedCredKey =
    typeof heterogeneousProvider?.env?.CLAUDE_CODE_CRED_KEY === 'string' &&
    heterogeneousProvider.env.CLAUDE_CODE_CRED_KEY.length > 0
      ? heterogeneousProvider.env.CLAUDE_CODE_CRED_KEY
      : CLAUDE_TOKEN_CRED_KEY;
  const hasCredInVault = (credsData?.data ?? []).some((c) => c.key === referencedCredKey);
  // isConfigured is true when:
  // 1. Running on desktop (local execution, no cloud creds needed), or
  // 2. No heterogeneous provider on this agent, or
  // 3. Provider is not claude-code (e.g. codex — no cloud credential required), or
  // 4. The referenced credential actually exists in the vault after the list settles, or
  // 5. Credentials are still loading — treat as configured to avoid a flash of the
  //    "not configured" alert that immediately disappears once the query resolves
  const isConfigured = !needsCredCheck || hasCredInVault || isCredsLoading;

  const goToConfig = () => {
    if (agentId) {
      router.push(urlJoin('/agent', agentId, 'profile'));
    }
  };

  return { goToConfig, isConfigured };
};
