// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAgentListItem } from './types';
import { useAgentRowActions } from './useAgentRowActions';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  dangerConfirm: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  onChanged: vi.fn(),
  reasonModal: vi.fn(),
  runAdminMutation: vi.fn(),
  setDefaultInbox: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}));
vi.mock('@lobehub/ui', () => ({ Flexbox: () => null, Text: () => null }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Input: () => null,
  Select: () => null,
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    warning: (...args: unknown[]) => mocks.toastWarning(...args),
  },
}));
vi.mock('@/enterprise/client/features/admin/primitives/DangerConfirm', () => ({
  openDangerConfirm: (...args: unknown[]) => mocks.dangerConfirm(...args),
}));
vi.mock('@/enterprise/client/features/admin/primitives/runAdminMutation', () => ({
  runAdminMutation: (...args: unknown[]) => mocks.runAdminMutation(...args),
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: (...args: unknown[]) => mocks.reasonModal(...args),
}));
vi.mock('./useAdminAgentReplacementCandidates', () => ({
  useAdminAgentReplacementCandidates: () => ({ data: [], error: undefined, isLoading: false }),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    archive: (...args: unknown[]) => mocks.archive(...args),
    get: (...args: unknown[]) => mocks.get(...args),
    list: (...args: unknown[]) => mocks.list(...args),
    setDefaultInbox: (...args: unknown[]) => mocks.setDefaultInbox(...args),
  },
}));

const row = (id: string, over: Partial<AdminAgentListItem['identity']> = {}): AdminAgentListItem =>
  ({
    assignmentCount: 0,
    displayName: id,
    identity: { agentKey: id, id, isDefault: false, status: 'published', systemKey: null, ...over },
  }) as never;

const detail = (id: string, revision: number, token: string, isDefault = false) => ({
  draftToken: token.repeat(64),
  identity: { agentKey: id, id, isDefault, revision, status: 'published', systemKey: null },
});

const render = () =>
  renderHook(() => useAgentRowActions({ authMethod: 'better-auth', onChanged: mocks.onChanged }));

/** Run whatever `openDangerConfirm` was handed as its confirm callback. */
const confirm = async () => {
  const { onConfirm } = mocks.dangerConfirm.mock.calls.at(-1)![0] as {
    onConfirm: () => Promise<void>;
  };
  await act(async () => {
    await onConfirm();
  });
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.onChanged.mockResolvedValue(undefined);
  // Default: the mutation commits.
  mocks.runAdminMutation.mockImplementation(async ({ run }: { run: () => Promise<void> }) => {
    await run();
    return true;
  });
});

describe('useAgentRowActions.setDefaultInbox', () => {
  it('freezes BOTH sides of the CAS before confirming, then commits and revalidates', async () => {
    mocks.get.mockImplementation(async ({ id }: { id: string }) =>
      id === 'agent-1' ? detail('agent-1', 3, 'a') : detail('agent-old', 9, 'b', true),
    );
    mocks.list.mockResolvedValue({ items: [{ identity: { id: 'agent-old', isDefault: true } }] });

    const { result } = render();
    await act(async () => {
      await result.current.setDefaultInbox(row('agent-1'));
    });

    // The outgoing default is resolved by a dedicated isDefault read, never a catalog page walk.
    expect(mocks.list).toHaveBeenCalledWith({ isDefault: true, limit: 1 });
    expect(mocks.setDefaultInbox).not.toHaveBeenCalled();

    await confirm();

    expect(mocks.setDefaultInbox).toHaveBeenCalledWith({
      currentDefault: {
        agentId: 'agent-old',
        expectedDraftToken: 'b'.repeat(64),
        expectedRevision: 9,
      },
      nextDefault: {
        agentId: 'agent-1',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 3,
      },
    });
    // Two rows changed — the list is refetched rather than patched.
    expect(mocks.onChanged).toHaveBeenCalledOnce();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.defaultSwitch.success');
  });

  it('sends a null currentDefault when there is no outgoing default to demote', async () => {
    mocks.get.mockResolvedValue(detail('agent-1', 3, 'a'));
    mocks.list.mockResolvedValue({ items: [] });

    const { result } = render();
    await act(async () => {
      await result.current.setDefaultInbox(row('agent-1'));
    });
    await confirm();

    expect(mocks.setDefaultInbox.mock.calls[0]![0]).toMatchObject({ currentDefault: null });
  });

  it('never opens the confirmation when the CAS preflight fails', async () => {
    mocks.get.mockRejectedValue(new Error('offline'));

    const { result } = render();
    await act(async () => {
      await result.current.setDefaultInbox(row('agent-1'));
    });

    expect(mocks.dangerConfirm).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('agentCatalog.toast.actionFailed');
  });

  it('does not revalidate or claim success when the mutation did not commit', async () => {
    mocks.get.mockResolvedValue(detail('agent-1', 3, 'a'));
    mocks.list.mockResolvedValue({ items: [] });
    mocks.runAdminMutation.mockResolvedValue(false);

    const { result } = render();
    await act(async () => {
      await result.current.setDefaultInbox(row('agent-1'));
    });
    await confirm();

    expect(mocks.onChanged).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('reports a failed revalidation rather than leaving a silently stale list', async () => {
    mocks.get.mockResolvedValue(detail('agent-1', 3, 'a'));
    mocks.list.mockResolvedValue({ items: [] });
    mocks.onChanged.mockRejectedValue(new Error('offline'));

    const { result } = render();
    await act(async () => {
      await result.current.setDefaultInbox(row('agent-1'));
    });
    await confirm();

    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.recovery.refreshFailed');
    // The write DID commit, so success is still reported.
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.defaultSwitch.success');
  });
});

describe('useAgentRowActions.archive', () => {
  const openArchive = async (isDefault = false) => {
    mocks.get.mockResolvedValue(detail('agent-1', 4, 'c', isDefault));
    const { result } = render();
    await act(async () => {
      await result.current.archive(row('agent-1', { isDefault }));
    });
    return mocks.reasonModal.mock.calls.at(-1)![0] as {
      autoReason: string;
      buildPayload: (reason: string) => unknown;
      danger: boolean;
      hideReason: boolean;
      onSubmit: (input: unknown) => Promise<void>;
      validateExtra: () => string | null;
    };
  };

  it('confirms destructively without asking the operator to type a reason', async () => {
    const modal = await openArchive();
    expect(modal.danger).toBe(true);
    expect(modal.hideReason).toBe(true);
    expect(modal.autoReason).toBeTruthy();
    expect(modal.buildPayload('r')).toMatchObject({
      agentId: 'agent-1',
      expectedDraftToken: 'c'.repeat(64),
      expectedRevision: 4,
      reason: 'r',
      replacementAgentId: null,
    });
  });

  it('commits the archive and revalidates the list', async () => {
    const modal = await openArchive();
    await act(async () => {
      await modal.onSubmit(modal.buildPayload('r'));
    });
    expect(mocks.archive).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-1' }));
    expect(mocks.onChanged).toHaveBeenCalledOnce();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.toast.archived');
  });

  it('lets a failure through so the modal can run its reauth retry', async () => {
    const modal = await openArchive();
    mocks.archive.mockRejectedValue(new Error('reauth required'));
    await expect(modal.onSubmit(modal.buildPayload('r'))).rejects.toThrow('reauth required');
    expect(mocks.onChanged).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('blocks archiving the default assistant until a successor is chosen', async () => {
    const modal = await openArchive(true);
    expect(modal.validateExtra()).toBe('agentCatalog.archive.noReplacement');
    expect((await openArchive(false)).validateExtra()).toBeNull();
  });

  it('never opens the modal when the CAS preflight fails', async () => {
    mocks.get.mockRejectedValue(new Error('offline'));
    const { result } = render();
    await act(async () => {
      await result.current.archive(row('agent-1'));
    });
    expect(mocks.reasonModal).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });
});
