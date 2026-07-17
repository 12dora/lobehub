// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAgentDetailOutput } from './types';
import { useAssignmentEditor } from './useAssignmentEditor';
import type { RefreshLock } from './useRefreshLock';

const mocks = vi.hoisted(() => ({ openReasonModal: vi.fn(), previewAssignment: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { previewAssignment: mocks.previewAssignment },
}));
vi.mock('@lobehub/ui/base-ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const snapshot = {
  assignments: [],
  draftToken: 'b'.repeat(64),
  identity: {
    agentKey: 'inbox',
    currentVersionId: 'v1',
    draftSequence: 1,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 4,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [{ id: 'v1', version: '1.0.0' }],
} as unknown as AdminAgentDetailOutput;

const lock: RefreshLock = {
  isLocked: () => false,
  refreshFailed: false,
  retryRefresh: vi.fn(),
  syncAfterCommit: vi.fn(),
};

const setup = () => renderHook(() => useAssignmentEditor(snapshot, null, lock));

const preview = async (result: { current: ReturnType<typeof useAssignmentEditor> }) => {
  mocks.previewAssignment.mockResolvedValue({ estimatedUsers: 5, warnings: [] });
  await act(async () => {
    await result.current.previewAssignment();
  });
};

describe('assignment preview invalidation (B6)', () => {
  beforeEach(() => {
    mocks.openReasonModal.mockReset();
    mocks.previewAssignment.mockReset();
  });

  it.each<[string, (e: ReturnType<typeof useAssignmentEditor>) => void]>([
    ['targetType', (e) => e.setTargetType('global_role')],
    ['targetId', (e) => e.setTargetId('user-9')],
    ['mode', (e) => e.setMode('mandatory')],
    ['enabled', (e) => e.setEnabled(false)],
    ['versionPolicy', (e) => e.setVersionPolicy('latest_published')],
    ['pinnedVersionId', (e) => e.setPinnedVersionId('v2')],
  ])('hides a stale preview after changing %s', async (_field, mutate) => {
    const { result } = setup();
    // A fully-specified valid draft (pinned) so EVERY field change is a real change.
    act(() => {
      result.current.setTargetType('user');
      result.current.setTargetId('user-1');
      result.current.setVersionPolicy('pinned');
      result.current.setPinnedVersionId('v1');
    });
    await preview(result);
    expect(result.current.preview).toEqual({ estimatedUsers: 5, warnings: [] });

    act(() => mutate(result.current));
    expect(result.current.preview).toBeNull();
  });

  it('previews and mutates with the IDENTICAL assignment payload while unchanged', async () => {
    const { result } = setup();
    act(() => {
      result.current.setTargetType('global_role');
      result.current.setTargetId('role-admins');
      result.current.setMode('mandatory');
    });
    await preview(result);

    const previewAssignmentArg = mocks.previewAssignment.mock.calls.at(-1)![0].assignment;

    act(() => result.current.submit());
    const built = mocks.openReasonModal.mock.calls.at(-1)![0].buildPayload('why');

    // The preview payload and the mutation payload describe the exact same assignment.
    expect({
      enabled: built.enabled,
      mode: built.mode,
      pinnedVersionId: built.pinnedVersionId,
      targetId: built.targetId,
      targetType: built.targetType,
      versionPolicy: built.versionPolicy,
    }).toEqual(previewAssignmentArg);
  });
});
