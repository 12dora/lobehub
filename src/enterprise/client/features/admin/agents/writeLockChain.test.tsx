// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { isAgentDetailFresh } from './AgentDetailView';
import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import { useAssignmentEditor } from './useAssignmentEditor';
import { useRefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
  service: { publish: vi.fn(), upsertAssignment: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: mocks.service }));
vi.mock('./useAdminAgents', () => ({ fetchAllAdminAgents: vi.fn().mockResolvedValue([]) }));
vi.mock('@lobehub/ui', () => ({ Flexbox: () => null, Text: () => null }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Select: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const permissions = deriveAdminAgentPermissions([
  PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  PLATFORM_PERMISSIONS.AGENT_UPDATE,
  PLATFORM_PERMISSIONS.AGENT_ASSIGN,
]);

const detail = (revision: number, token: string): AdminAgentDetailOutput =>
  ({
    assignments: [],
    draftToken: token.repeat(64),
    identity: { agentKey: 'a', currentVersionId: 'v1', id: 'agent-1', revision },
    rollouts: [],
    versions: [],
  }) as unknown as AdminAgentDetailOutput;

const lastConfig = () => mocks.openReasonModal.mock.calls.at(-1)![0];

beforeEach(() => {
  mocks.openReasonModal.mockReset();
  mocks.service.publish
    .mockReset()
    .mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
  mocks.service.upsertAssignment.mockReset().mockResolvedValue({ id: 'assignment-1' });
});

describe('publish → refresh-fail write lock (real actions + real lock)', () => {
  it('blocks the second publish, ignores a background CAS advance, unlocks on a fresh retry, and reuses the new CAS', async () => {
    const live = { current: detail(7, 'b') };
    const mutate = vi
      .fn<() => Promise<AdminAgentDetailOutput | undefined>>()
      .mockResolvedValueOnce(undefined) // refresh after commit fails → lock (baseline = revision 7)
      .mockResolvedValueOnce(detail(8, 'c')); // manual retry: revision 8 > frozen 7 → fresh

    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: AdminAgentDetailOutput }) => {
        const lock = useRefreshLock<AdminAgentDetailOutput>(mutate, {
          getSnapshot: () => live.current,
          isFresh: isAgentDetailFresh,
        });
        return useAgentActions({
          authMethod: null,
          editor: { draft: null } as never,
          lock,
          mutate,
          permissions,
          snapshot,
        });
      },
      { initialProps: { snapshot: detail(7, 'b') } },
    );

    // Commit publish; its post-commit refresh fails → locked.
    act(() => result.current.publish('v1'));
    await act(async () => {
      await lastConfig().onSubmit(lastConfig().buildPayload('reason'));
    });
    expect(mocks.service.publish).toHaveBeenCalledTimes(1);

    // Second publish while locked fires NO service call and opens no modal.
    const modalCalls = mocks.openReasonModal.mock.calls.length;
    act(() => result.current.publish('v1'));
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls);
    expect(mocks.service.publish).toHaveBeenCalledTimes(1);

    // A background revalidation advances the LIVE snapshot to revision 8 — must not be the baseline.
    live.current = detail(8, 'c');
    await act(async () => {
      await result.current.retryRefresh();
    });

    // Re-enabled: the surface re-renders with the advanced CAS; the next publish uses it.
    rerender({ snapshot: detail(8, 'c') });
    act(() => result.current.publish('v1'));
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls + 1);
    const built = lastConfig().buildPayload('again');
    expect(built.expectedRevision).toBe(8);
    expect(built.expectedDraftToken).toBe('c'.repeat(64));
  });
});

describe('assignment upsert → refresh-fail write lock (real editor + real lock)', () => {
  it('blocks a second submit while locked and reuses the new CAS after a fresh retry', async () => {
    const live = { current: detail(4, 'b') };
    const mutate = vi
      .fn<() => Promise<AdminAgentDetailOutput | undefined>>()
      .mockResolvedValueOnce(undefined) // refresh fails → lock (baseline = revision 4)
      .mockResolvedValueOnce(detail(5, 'c')); // retry: revision 5 > frozen 4 → fresh

    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: AdminAgentDetailOutput }) => {
        const lock = useRefreshLock<AdminAgentDetailOutput>(mutate, {
          getSnapshot: () => live.current,
          isFresh: isAgentDetailFresh,
        });
        return { editor: useAssignmentEditor(snapshot, null, lock), lock };
      },
      { initialProps: { snapshot: detail(4, 'b') } },
    );

    // Commit an assignment upsert (global default draft is valid); its refresh fails → lock.
    act(() => result.current.editor.submit());
    await act(async () => {
      await lastConfig().onSubmit(lastConfig().buildPayload('reason'));
    });
    expect(mocks.service.upsertAssignment).toHaveBeenCalledTimes(1);
    expect(result.current.lock.isLocked()).toBe(true);

    // Second submit while locked → no modal, no service call.
    const modalCalls = mocks.openReasonModal.mock.calls.length;
    act(() => result.current.editor.submit());
    expect(mocks.openReasonModal.mock.calls.length).toBe(modalCalls);
    expect(mocks.service.upsertAssignment).toHaveBeenCalledTimes(1);

    // Manual retry with a fresh advanced detail unlocks; the re-rendered surface uses the new CAS.
    live.current = detail(5, 'c');
    await act(async () => {
      await result.current.lock.retryRefresh();
    });
    rerender({ snapshot: detail(5, 'c') });
    act(() => result.current.editor.submit());
    const built = lastConfig().buildPayload('again');
    expect(built.expectedRevision).toBe(5);
    expect(built.expectedDraftToken).toBe('c'.repeat(64));
  });
});
