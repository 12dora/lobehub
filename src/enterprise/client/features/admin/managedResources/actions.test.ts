import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminManagedResourcesSaveOutput } from '@/server/enterprise/contracts/adminManagedResources';

import { saveManagedResourcePolicy } from './actions';

const input = () => ({
  draft: {
    agents: { enforcementMode: 'observe' as const, managed: false },
    aiModels: { enforcementMode: 'observe' as const, managed: false },
    aiProviders: { enforcementMode: 'observe' as const, managed: false },
    connectors: { enforcementMode: 'enforced' as const, managed: true },
    skills: { enforcementMode: 'observe' as const, managed: false },
  },
  expectedDraftToken: 'a'.repeat(64),
  expectedRevision: 3,
  reason: 'enable managed connectors',
});

describe('managed resource policy actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps one immutable CAS payload through reauth and refreshes capabilities after success', async () => {
    const save = vi.fn().mockResolvedValue({
      auditId: 'a0',
      revision: 4,
      runtimeTransition: 'finalized' as const,
    });
    const refreshCapabilities = vi.fn().mockResolvedValue(undefined);
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof save>) => {
      try {
        return await fn();
      } catch {
        return fn();
      }
    });
    save.mockRejectedValueOnce(new Error('ADMIN_REAUTH_REQUIRED'));

    const result = await saveManagedResourcePolicy({
      authMethod: 'better-auth',
      input: input(),
      refreshCapabilities,
      save,
      withReauthRetry,
    });

    expect(withReauthRetry).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0]).toBe(save.mock.calls[1][0]);
    expect(Object.isFrozen(save.mock.calls[0][0])).toBe(true);
    expect(save.mock.calls[0][0]).toMatchObject({ expectedRevision: 3 });
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
    expect(result.capabilityRefreshFailed).toBe(false);
  });

  it.each(['reauth cancelled', 'reauth failed'])(
    'does not report success or refresh capabilities when %s',
    async (message) => {
      const save = vi.fn();
      const refreshCapabilities = vi.fn();
      const withReauthRetry = vi.fn().mockRejectedValue(new Error(message));

      await expect(
        saveManagedResourcePolicy({
          authMethod: 'better-auth',
          input: input(),
          refreshCapabilities,
          save,
          withReauthRetry,
        }),
      ).rejects.toThrow(message);

      expect(save).not.toHaveBeenCalled();
      expect(refreshCapabilities).not.toHaveBeenCalled();
    },
  );

  it('returns save success even when capability refresh rejects', async () => {
    const save = vi.fn().mockResolvedValue({
      auditId: 'a1',
      revision: 4,
      runtimeTransition: 'finalized' as const,
    });
    const refreshCapabilities = vi.fn().mockRejectedValue(new Error('refresh blew up'));
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof save>) => fn());

    const result = await saveManagedResourcePolicy({
      authMethod: 'better-auth',
      input: input(),
      refreshCapabilities,
      save,
      withReauthRetry,
    });

    expect(result).toEqual({
      capabilityRefreshFailed: true,
      output: { auditId: 'a1', revision: 4, runtimeTransition: 'finalized' },
    });
    expect(refreshCapabilities).toHaveBeenCalledTimes(1);
  });

  it('notifies the commit boundary before the capability refresh and survives its faults', async () => {
    const order: string[] = [];
    const save = vi.fn(async (): Promise<AdminManagedResourcesSaveOutput> => {
      order.push('save');
      return { auditId: 'a3', revision: 6, runtimeTransition: 'finalized' };
    });
    const refreshCapabilities = vi.fn(async () => {
      order.push('refreshCapabilities');
    });
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof save>) => fn());
    const onCommitted = vi.fn(() => {
      order.push('onCommitted');
      throw new Error('toast blew up');
    });

    const result = await saveManagedResourcePolicy({
      authMethod: 'better-auth',
      input: input(),
      onCommitted,
      refreshCapabilities,
      save,
      withReauthRetry,
    });

    expect(order).toEqual(['save', 'onCommitted', 'refreshCapabilities']);
    expect(onCommitted).toHaveBeenCalledWith({
      auditId: 'a3',
      revision: 6,
      runtimeTransition: 'finalized',
    });
    expect(result.capabilityRefreshFailed).toBe(false);
  });

  it('surfaces pending_recovery as a committed save', async () => {
    const save = vi.fn().mockResolvedValue({
      auditId: 'a2',
      revision: 5,
      runtimeTransition: 'pending_recovery' as const,
    });
    const refreshCapabilities = vi.fn().mockResolvedValue(undefined);
    const withReauthRetry = vi.fn(async (fn: () => ReturnType<typeof save>) => fn());

    const result = await saveManagedResourcePolicy({
      authMethod: 'better-auth',
      input: input(),
      refreshCapabilities,
      save,
      withReauthRetry,
    });

    expect(result).toEqual({
      capabilityRefreshFailed: false,
      output: { auditId: 'a2', revision: 5, runtimeTransition: 'pending_recovery' },
    });
  });
});
