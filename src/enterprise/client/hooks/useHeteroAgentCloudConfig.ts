import { isDesktop } from '@lobechat/const';
import urlJoin from 'url-join';

import { useQueryRoute } from '@/hooks/useQueryRoute';
import { lambdaQuery } from '@/libs/trpc/client';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

// Fixed cred key — must stay in sync with CloudHeterogeneousConfig
export const CLAUDE_TOKEN_CRED_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Discrete credential-readiness states for cloud heterogeneous agents.
 *
 * Callers must not collapse these into a single boolean: a list-query failure
 * is retryable, while `not-configured` means the vault settled without the
 * referenced key (deleted or stale reference).
 */
export type HeteroAgentCloudCredStatus =
  'skipped' | 'loading' | 'error' | 'configured' | 'not-configured';

export interface ResolveHeteroAgentCloudCredStatusInput {
  isCredsError: boolean;
  isCredsLoading: boolean;
  needsCredCheck: boolean;
  referencedCredKey: string;
  /** Vault keys from a settled list response; undefined while still loading. */
  vaultKeys: readonly string[] | undefined;
}

export interface ResolvedHeteroAgentCloudCredStatus {
  isConfigured: boolean;
  isError: boolean;
  isLoading: boolean;
  status: HeteroAgentCloudCredStatus;
}

/**
 * Pure status resolver — vault membership is authoritative after the list
 * settles. Loading and query failures are never merged into `isConfigured`.
 */
export function resolveHeteroAgentCloudCredStatus(
  input: ResolveHeteroAgentCloudCredStatusInput,
): ResolvedHeteroAgentCloudCredStatus {
  if (!input.needsCredCheck) {
    return { isConfigured: true, isError: false, isLoading: false, status: 'skipped' };
  }

  // Do not infer readiness while the vault membership query is in flight.
  if (input.isCredsLoading) {
    return { isConfigured: false, isError: false, isLoading: true, status: 'loading' };
  }

  // List-query failure is distinct from "genuinely not configured".
  if (input.isCredsError) {
    return { isConfigured: false, isError: true, isLoading: false, status: 'error' };
  }

  const hasCredInVault = (input.vaultKeys ?? []).includes(input.referencedCredKey);
  if (hasCredInVault) {
    return { isConfigured: true, isError: false, isLoading: false, status: 'configured' };
  }

  return { isConfigured: false, isError: false, isLoading: false, status: 'not-configured' };
}

/** Env value is only a lookup key; empty/missing falls back to the fixed token key. */
export function resolveReferencedCredKey(envCredKey: unknown): string {
  return typeof envCredKey === 'string' && envCredKey.length > 0
    ? envCredKey
    : CLAUDE_TOKEN_CRED_KEY;
}

export interface HeteroAgentCloudConfig {
  /** Underlying list-query error when `status === 'error'`; otherwise null. */
  error: unknown;
  goToConfig: () => void;
  /**
   * True only when no cloud credential is required, or the referenced vault
   * entry was confirmed present after the list settled. Never true while
   * loading or after a list-query failure.
   */
  isConfigured: boolean;
  isError: boolean;
  isLoading: boolean;
  /** Re-run the credential list query (retry after `status === 'error'`). */
  refetch: () => void;
  status: HeteroAgentCloudCredStatus;
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
  const {
    data: credsData,
    error: credsError,
    isError: isCredsError,
    isLoading: isCredsLoading,
    refetch,
  } = lambdaQuery.market.creds.list.useQuery(undefined, { enabled: needsCredCheck });

  // Resolve the vault key the agent points at (env ref) or the fixed default token key.
  // Presence of CLAUDE_CODE_CRED_KEY alone is only a *reference* — not proof the secret still exists.
  const referencedCredKey = resolveReferencedCredKey(
    heterogeneousProvider?.env?.CLAUDE_CODE_CRED_KEY,
  );
  const vaultKeys = credsData?.data?.map((c) => c.key);

  const resolved = resolveHeteroAgentCloudCredStatus({
    isCredsError: needsCredCheck && isCredsError,
    isCredsLoading: needsCredCheck && isCredsLoading,
    needsCredCheck,
    referencedCredKey,
    vaultKeys,
  });

  const goToConfig = () => {
    if (agentId) {
      router.push(urlJoin('/agent', agentId, 'profile'));
    }
  };

  return {
    ...resolved,
    error: needsCredCheck && isCredsError ? credsError : null,
    goToConfig,
    refetch: () => {
      void refetch();
    },
  };
};
