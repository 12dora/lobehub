/**
 * Post-commit soft refresh: mutation success must not become a mutation failure
 * when SWR invalidation rejects (would invite unsafe retries of holds/exports/runs).
 * @vitest-environment happy-dom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_AUDIT_EXPORTS_LIST_KEY,
  ADMIN_AUDIT_HOLDS_LIST_KEY,
  ADMIN_AUDIT_POLICY_KEY,
  ADMIN_AUDIT_RETENTION_RUNS_KEY,
} from '../swrKeys';
import { useAdminAuditMutations } from './useAdminAudit';

const toastWarning = vi.fn();
const mutateMock = vi.fn();
const createLegalHoldMock = vi.fn();
const releaseLegalHoldMock = vi.fn();
const retentionRunMock = vi.fn();
const updatePolicyMock = vi.fn();

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { warning: (...args: unknown[]) => toastWarning(...args) },
}));

vi.mock('i18next', () => ({
  default: {
    t: (key: string) => key,
  },
}));

vi.mock('swr', () => ({
  mutate: (...args: unknown[]) => mutateMock(...args),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminAudit', () => ({
  adminAuditService: {
    cancelExport: vi.fn(),
    cancelRetentionRun: vi.fn(),
    createExport: vi.fn(),
    createLegalHold: (...args: unknown[]) => createLegalHoldMock(...args),
    downloadExport: vi.fn(),
    releaseLegalHold: (...args: unknown[]) => releaseLegalHoldMock(...args),
    retentionDryRun: vi.fn(),
    retentionRun: (...args: unknown[]) => retentionRunMock(...args),
    updatePolicy: (...args: unknown[]) => updatePolicyMock(...args),
  },
}));

describe('useAdminAuditMutations soft refresh', () => {
  beforeEach(() => {
    toastWarning.mockReset();
    mutateMock.mockReset();
    createLegalHoldMock.mockReset();
    releaseLegalHoldMock.mockReset();
    retentionRunMock.mockReset();
    updatePolicyMock.mockReset();
  });

  it('resolves createLegalHold and warns when post-commit refresh fails', async () => {
    const committed = { id: 'hold-1', status: 'active' as const };
    createLegalHoldMock.mockResolvedValue(committed);
    mutateMock.mockRejectedValue(new Error('SWR_REFRESH_FAILED'));

    const { result } = renderHook(() => useAdminAuditMutations());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.createLegalHold({
        reason: 'litigation',
        scopeType: 'user',
        scopeId: 'u1',
      } as never);
    });

    expect(resolved).toEqual(committed);
    expect(createLegalHoldMock).toHaveBeenCalledTimes(1);
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(toastWarning.mock.calls[0]![0]).toBe('audit.toast.savedRefreshFailed');
  });

  it('resolves releaseLegalHold cleanly when refresh succeeds (no warning)', async () => {
    const committed = { id: 'hold-1', status: 'released' as const };
    releaseLegalHoldMock.mockResolvedValue(committed);
    mutateMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAdminAuditMutations());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.releaseLegalHold({
        id: 'hold-1',
        releaseReason: 'case closed',
      });
    });

    expect(resolved).toEqual(committed);
    expect(toastWarning).not.toHaveBeenCalled();
    // Holds list invalidation predicate was attempted.
    expect(mutateMock).toHaveBeenCalled();
    const predicate = mutateMock.mock.calls[0]![0] as (key: unknown) => boolean;
    expect(predicate([ADMIN_AUDIT_HOLDS_LIST_KEY])).toBe(true);
  });

  it('resolves retentionRun and warns when list invalidation rejects', async () => {
    const committed = { items: [{ id: 'run-1' }] };
    retentionRunMock.mockResolvedValue(committed);
    mutateMock.mockRejectedValue(new Error('RETENTION_REFRESH_FAILED'));

    const { result } = renderHook(() => useAdminAuditMutations());
    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.retentionRun({ reason: 'cleanup', scope: 'all' });
    });

    expect(resolved).toEqual(committed);
    expect(retentionRunMock).toHaveBeenCalledWith({ reason: 'cleanup', scope: 'all' });
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const predicate = mutateMock.mock.calls[0]![0] as (key: unknown) => boolean;
    expect(predicate([ADMIN_AUDIT_RETENTION_RUNS_KEY])).toBe(true);
  });

  it('still rejects when the service mutation itself fails', async () => {
    updatePolicyMock.mockRejectedValue(new Error('REVISION_CONFLICT'));
    mutateMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAdminAuditMutations());
    await expect(
      act(async () => {
        await result.current.updatePolicy({
          expectedRevision: 1,
          maxListWindowDays: 7,
          reason: 'tighten',
        } as never);
      }),
    ).rejects.toThrow('REVISION_CONFLICT');
    // Soft refresh must not run after a failed commit.
    expect(mutateMock).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it('invalidates the correct SWR key family for policy and exports', async () => {
    updatePolicyMock.mockResolvedValue({ revision: 2 });
    mutateMock.mockResolvedValue(undefined);

    const { result } = renderHook(() => useAdminAuditMutations());
    await act(async () => {
      await result.current.updatePolicy({
        expectedRevision: 1,
        maxListWindowDays: 14,
        reason: 'widen',
      } as never);
    });

    const policyPred = mutateMock.mock.calls[0]![0] as (key: unknown) => boolean;
    expect(policyPred([ADMIN_AUDIT_POLICY_KEY])).toBe(true);
    expect(policyPred([ADMIN_AUDIT_EXPORTS_LIST_KEY])).toBe(false);
  });
});
