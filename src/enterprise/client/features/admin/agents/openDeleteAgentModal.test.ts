import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openDeleteAgentModal } from './openDeleteAgentModal';

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  openReasonModal: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { delete: mocks.delete },
}));

describe('openDeleteAgentModal', () => {
  beforeEach(() => {
    mocks.delete.mockReset();
    mocks.openReasonModal.mockReset();
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
  });

  it('submits agentId + expected CAS + fixed reason, and runs onDeleted only after commit', async () => {
    mocks.delete.mockResolvedValue({ deleted: true });
    const onDeleted = vi.fn().mockResolvedValue(undefined);

    openDeleteAgentModal({
      agentId: 'agent-1',
      authMethod: 'better-auth',
      displayName: 'Support',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      onDeleted,
    });

    expect(mocks.openReasonModal).toHaveBeenCalledOnce();
    const config = mocks.openReasonModal.mock.calls[0]![0] as {
      authMethod?: string;
      autoReason?: string;
      buildPayload: (reason: string) => unknown;
      hideReason?: boolean;
      onSubmit: (payload: unknown) => Promise<void>;
    };
    expect(config.authMethod).toBe('better-auth');
    expect(config.hideReason).toBe(true);
    // Confirm-only modal submits the fixed audit reason (never free-form user text).
    expect(config.autoReason).toBe('Platform assistant hard-deleted from admin console');

    const payload = config.buildPayload(config.autoReason!);
    expect(payload).toEqual({
      agentId: 'agent-1',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      reason: 'Platform assistant hard-deleted from admin console',
    });

    await config.onSubmit(payload);
    expect(mocks.delete).toHaveBeenCalledWith(payload);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.toast.deleted');
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('does not emit the success toast or call onDeleted when the mutation fails', async () => {
    mocks.delete.mockRejectedValue(new Error('CAS conflict'));
    const onDeleted = vi.fn();

    openDeleteAgentModal({
      agentId: 'agent-1',
      displayName: 'Support',
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      onDeleted,
    });

    const config = mocks.openReasonModal.mock.calls[0]![0] as {
      buildPayload: (reason: string) => unknown;
      onSubmit: (payload: unknown) => Promise<void>;
    };
    const payload = config.buildPayload('x');
    await expect(config.onSubmit(payload)).rejects.toThrow('CAS conflict');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
