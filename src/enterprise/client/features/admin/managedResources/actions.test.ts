import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publishManagedResourcePolicy, saveManagedResourceDraft } from './actions';

describe('managed resource policy actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves the exact draft CAS token and trimmed reason supplied by the page', async () => {
    const saveDraft = vi.fn().mockResolvedValue({ baseRevision: 3, draftToken: 'draft-3' });
    const input = {
      draft: {
        agents: { enforcementMode: 'observe' as const, managed: false },
        aiModels: { enforcementMode: 'observe' as const, managed: false },
        aiProviders: { enforcementMode: 'observe' as const, managed: false },
        connectors: { enforcementMode: 'enforced' as const, managed: true },
        skills: { enforcementMode: 'observe' as const, managed: false },
      },
      expectedDraftToken: 'draft-2',
      reason: 'enable managed connectors',
    };

    await saveManagedResourceDraft({ input, saveDraft });
    expect(saveDraft).toHaveBeenCalledWith(input);
  });

  it('keeps one immutable publish payload through reauth and refreshes capabilities after success', async () => {
    const publish = vi.fn().mockResolvedValue({
      auditId: 'a0',
      revision: 4,
      runtimeTransition: 'finalized' as const,
    });
    const refreshCapabilities = vi.fn().mockResolvedValue(undefined);
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof publish>) => {
      try {
        return await fn();
      } catch {
        return fn();
      }
    });
    publish.mockRejectedValueOnce(new Error('ADMIN_REAUTH_REQUIRED'));
    const input = {
      expectedDraftToken: 'draft-3',
      expectedRevision: 3,
      reason: 'publish policy',
    };

    const result = await publishManagedResourcePolicy({
      authMethod: 'better-auth',
      input,
      publish,
      refreshCapabilities,
      withReauthRetry,
    });

    expect(withReauthRetry).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][0]).toBe(publish.mock.calls[1][0]);
    expect(Object.isFrozen(publish.mock.calls[0][0])).toBe(true);
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
    expect(result.capabilityRefreshFailed).toBe(false);
  });

  it.each(['reauth cancelled', 'reauth failed'])(
    'does not publish success or refresh capabilities when %s',
    async (message) => {
      const publish = vi.fn();
      const refreshCapabilities = vi.fn();
      const withReauthRetry = vi.fn().mockRejectedValue(new Error(message));

      await expect(
        publishManagedResourcePolicy({
          authMethod: 'better-auth',
          input: {
            expectedDraftToken: 'draft-3',
            expectedRevision: 3,
            reason: 'publish policy',
          },
          publish,
          refreshCapabilities,
          withReauthRetry,
        }),
      ).rejects.toThrow(message);

      expect(publish).not.toHaveBeenCalled();
      expect(refreshCapabilities).not.toHaveBeenCalled();
    },
  );

  it('returns publish success even when capability refresh rejects', async () => {
    const publish = vi.fn().mockResolvedValue({
      auditId: 'a1',
      revision: 4,
      runtimeTransition: 'finalized' as const,
    });
    const refreshCapabilities = vi.fn().mockRejectedValue(new Error('refresh blew up'));
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof publish>) => fn());

    const result = await publishManagedResourcePolicy({
      authMethod: 'better-auth',
      input: {
        expectedDraftToken: 'draft-3',
        expectedRevision: 3,
        reason: 'publish policy',
      },
      publish,
      refreshCapabilities,
      withReauthRetry,
    });

    expect(result).toEqual({
      capabilityRefreshFailed: true,
      output: { auditId: 'a1', revision: 4, runtimeTransition: 'finalized' },
    });
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
  });

  it('returns capabilityRefreshFailed false when refresh succeeds', async () => {
    const publish = vi.fn().mockResolvedValue({
      auditId: 'a2',
      revision: 5,
      runtimeTransition: 'finalized' as const,
    });
    const refreshCapabilities = vi.fn().mockResolvedValue(undefined);
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof publish>) => fn());

    const result = await publishManagedResourcePolicy({
      authMethod: 'better-auth',
      input: {
        expectedDraftToken: 'draft-4',
        expectedRevision: 4,
        reason: 'publish policy',
      },
      publish,
      refreshCapabilities,
      withReauthRetry,
    });

    expect(result).toEqual({
      capabilityRefreshFailed: false,
      output: { auditId: 'a2', revision: 5, runtimeTransition: 'finalized' },
    });
  });
});
