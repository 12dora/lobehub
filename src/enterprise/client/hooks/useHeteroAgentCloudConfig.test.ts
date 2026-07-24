/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_TOKEN_CRED_KEY,
  resolveHeteroAgentCloudCredStatus,
  resolveReferencedCredKey,
  useHeteroAgentCloudConfig,
} from './useHeteroAgentCloudConfig';

const queryState = vi.hoisted(() => ({
  data: undefined as { data: Array<{ key: string }> } | undefined,
  error: null as unknown,
  isError: false,
  isLoading: false,
  refetch: vi.fn(),
}));

const agentState = vi.hoisted(() => ({
  envCredKey: undefined as string | undefined,
  providerType: 'claude-code' as string | undefined,
}));

const isDesktopMock = vi.hoisted(() => ({ value: false }));

vi.mock('@lobechat/const', () => ({
  get isDesktop() {
    return isDesktopMock.value;
  },
}));

vi.mock('@/hooks/useQueryRoute', () => ({
  useQueryRoute: () => ({ push: vi.fn() }),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaQuery: {
    market: {
      creds: {
        list: {
          useQuery: () => ({
            data: queryState.data,
            error: queryState.error,
            isError: queryState.isError,
            isLoading: queryState.isLoading,
            refetch: queryState.refetch,
          }),
        },
      },
    },
  },
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) =>
    selector({/* shape unused — selector is mocked via agentByIdSelectors */}),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgencyConfigById: () => () =>
      agentState.providerType
        ? {
            heterogeneousProvider: {
              env: agentState.envCredKey ? { CLAUDE_CODE_CRED_KEY: agentState.envCredKey } : {},
              type: agentState.providerType,
            },
          }
        : undefined,
  },
}));

describe('resolveReferencedCredKey', () => {
  it('uses the env reference when present', () => {
    expect(resolveReferencedCredKey('my-vault-key')).toBe('my-vault-key');
  });

  it('falls back to the fixed token key when env is empty or missing', () => {
    expect(resolveReferencedCredKey(undefined)).toBe(CLAUDE_TOKEN_CRED_KEY);
    expect(resolveReferencedCredKey('')).toBe(CLAUDE_TOKEN_CRED_KEY);
    expect(resolveReferencedCredKey(42)).toBe(CLAUDE_TOKEN_CRED_KEY);
  });
});

describe('resolveHeteroAgentCloudCredStatus', () => {
  it('skips the check when no cloud credential is required', () => {
    expect(
      resolveHeteroAgentCloudCredStatus({
        isCredsError: false,
        isCredsLoading: false,
        needsCredCheck: false,
        referencedCredKey: CLAUDE_TOKEN_CRED_KEY,
        vaultKeys: undefined,
      }),
    ).toEqual({
      isConfigured: true,
      isError: false,
      isLoading: false,
      status: 'skipped',
    });
  });

  it('exposes loading separately and does not treat loading as configured', () => {
    const result = resolveHeteroAgentCloudCredStatus({
      isCredsError: false,
      isCredsLoading: true,
      needsCredCheck: true,
      referencedCredKey: CLAUDE_TOKEN_CRED_KEY,
      vaultKeys: undefined,
    });

    expect(result).toEqual({
      isConfigured: false,
      isError: false,
      isLoading: true,
      status: 'loading',
    });
  });

  it('surfaces list-query failure as error, not false not-configured', () => {
    const result = resolveHeteroAgentCloudCredStatus({
      isCredsError: true,
      isCredsLoading: false,
      needsCredCheck: true,
      referencedCredKey: CLAUDE_TOKEN_CRED_KEY,
      vaultKeys: undefined,
    });

    expect(result.status).toBe('error');
    expect(result.isError).toBe(true);
    expect(result.isConfigured).toBe(false);
    expect(result.isLoading).toBe(false);
    // Distinct from genuine not-configured: isError is the discriminator.
    expect(result.status).not.toBe('not-configured');
  });

  it('marks deleted credential reference (default key missing from vault) as not-configured', () => {
    // Agent still points at the default token key, but the vault entry was deleted.
    const result = resolveHeteroAgentCloudCredStatus({
      isCredsError: false,
      isCredsLoading: false,
      needsCredCheck: true,
      referencedCredKey: CLAUDE_TOKEN_CRED_KEY,
      vaultKeys: [{ key: 'OTHER_CRED' }].map((c) => c.key),
    });

    expect(result).toEqual({
      isConfigured: false,
      isError: false,
      isLoading: false,
      status: 'not-configured',
    });
  });

  it('marks expired/stale env reference as not-configured when key is absent from vault', () => {
    // Agent env still holds a stale CLAUDE_CODE_CRED_KEY after the vault secret was rotated/removed.
    const staleKey = 'stale-claude-oauth-ref';
    const result = resolveHeteroAgentCloudCredStatus({
      isCredsError: false,
      isCredsLoading: false,
      needsCredCheck: true,
      referencedCredKey: staleKey,
      vaultKeys: [CLAUDE_TOKEN_CRED_KEY, 'unrelated-key'],
    });

    expect(result.status).toBe('not-configured');
    expect(result.isConfigured).toBe(false);
    expect(result.isError).toBe(false);
  });

  it('is configured only when the referenced key is actually present in the vault', () => {
    const customKey = 'custom-claude-oauth';
    expect(
      resolveHeteroAgentCloudCredStatus({
        isCredsError: false,
        isCredsLoading: false,
        needsCredCheck: true,
        referencedCredKey: customKey,
        vaultKeys: [customKey],
      }),
    ).toEqual({
      isConfigured: true,
      isError: false,
      isLoading: false,
      status: 'configured',
    });
  });

  it('prefers loading over a concurrent error flag while the query is in flight', () => {
    // Defensive: while loading, do not surface a transient error as terminal.
    expect(
      resolveHeteroAgentCloudCredStatus({
        isCredsError: true,
        isCredsLoading: true,
        needsCredCheck: true,
        referencedCredKey: CLAUDE_TOKEN_CRED_KEY,
        vaultKeys: undefined,
      }).status,
    ).toBe('loading');
  });
});

describe('useHeteroAgentCloudConfig', () => {
  beforeEach(() => {
    isDesktopMock.value = false;
    agentState.providerType = 'claude-code';
    agentState.envCredKey = undefined;
    queryState.data = undefined;
    queryState.error = null;
    queryState.isError = false;
    queryState.isLoading = false;
    queryState.refetch.mockReset();
  });

  it('does not report configured while the credential list is loading', () => {
    queryState.isLoading = true;

    const { result } = renderHook(() => useHeteroAgentCloudConfig('agent-1'));

    expect(result.current.status).toBe('loading');
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isConfigured).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('reports not-configured when the default credential was deleted from the vault', () => {
    queryState.data = { data: [{ key: 'SOME_OTHER_KEY' }] };

    const { result } = renderHook(() => useHeteroAgentCloudConfig('agent-1'));

    expect(result.current.status).toBe('not-configured');
    expect(result.current.isConfigured).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('reports not-configured for a stale CLAUDE_CODE_CRED_KEY reference', () => {
    agentState.envCredKey = 'expired-ref-from-agent-env';
    queryState.data = {
      data: [{ key: CLAUDE_TOKEN_CRED_KEY }, { key: 'other' }],
    };

    const { result } = renderHook(() => useHeteroAgentCloudConfig('agent-1'));

    expect(result.current.status).toBe('not-configured');
    expect(result.current.isConfigured).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('surfaces list-query failure as error (retryable), not as not-configured', () => {
    const listError = new Error('creds list unavailable');
    queryState.isError = true;
    queryState.error = listError;

    const { result } = renderHook(() => useHeteroAgentCloudConfig('agent-1'));

    expect(result.current.status).toBe('error');
    expect(result.current.isError).toBe(true);
    expect(result.current.isConfigured).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe(listError);
    // Must not collapse into the "genuinely not configured" branch.
    expect(result.current.status).not.toBe('not-configured');
  });

  it('is configured when the referenced vault entry exists', () => {
    agentState.envCredKey = 'live-key';
    queryState.data = { data: [{ key: 'live-key' }] };

    const { result } = renderHook(() => useHeteroAgentCloudConfig('agent-1'));

    expect(result.current.status).toBe('configured');
    expect(result.current.isConfigured).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('skips vault checks for non-claude-code providers', () => {
    agentState.providerType = 'codex';

    const { result } = renderHook(() => useHeteroAgentCloudConfig('agent-1'));

    expect(result.current.status).toBe('skipped');
    expect(result.current.isConfigured).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });
});
