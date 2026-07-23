import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openDeleteProviderModal } from './openDeleteProviderModal';

const mocks = vi.hoisted(() => ({
  deleteProvider: vi.fn(),
  openReason: vi.fn(),
  reasonProps: null as null | {
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<void>;
  },
  toastSuccess: vi.fn(),
}));

vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { success: mocks.toastSuccess },
}));

vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: (props: unknown) => {
    mocks.reasonProps = props as typeof mocks.reasonProps;
    mocks.openReason(props);
  },
}));

vi.mock('@/enterprise/client/services/adminAiCatalog', () => ({
  adminAiCatalogService: {
    deleteProvider: mocks.deleteProvider,
  },
}));

describe('openDeleteProviderModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reasonProps = null;
    mocks.deleteProvider.mockResolvedValue({ deleted: true });
  });

  it('includes expectedDraftToken and expectedRevision in the delete payload', async () => {
    const onDeleted = vi.fn();
    openDeleteProviderModal({
      displayName: 'Alpha',
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 3,
      onDeleted,
      providerId: 'provider-1',
    });

    expect(mocks.openReason).toHaveBeenCalledOnce();
    const payload = mocks.reasonProps!.buildPayload('ignored-reason');
    expect(payload).toEqual({
      expectedDraftToken: 'd'.repeat(64),
      expectedRevision: 3,
      id: 'provider-1',
      reason: expect.any(String),
    });

    await mocks.reasonProps!.onSubmit(payload);
    expect(mocks.deleteProvider).toHaveBeenCalledWith(payload);
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});
