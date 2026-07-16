import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCatalogPermissions } from '../controller';
import { useGlobalModelActions } from './useGlobalModelActions';

const mocks = vi.hoisted(() => ({
  getCreateDraftContext: vi.fn(),
  openModelEditor: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: vi.fn(),
  toast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: vi.fn(),
}));

vi.mock('@/enterprise/client/services/adminAiCatalog', () => ({
  adminAiCatalogService: {
    getModelCreateDraftContext: mocks.getCreateDraftContext,
  },
}));

vi.mock('../models/openModelEditorModal', () => ({
  openModelEditorModal: mocks.openModelEditor,
}));

vi.mock('./useAdminAiCatalog', () => ({
  refreshAdminAiModelLists: vi.fn(),
}));

const permissions = {
  canArchiveProvider: false,
  canCreateModel: true,
  canCreateProvider: false,
  canDeleteModel: false,
  canPublishModel: false,
  canPublishProvider: false,
  canReadModels: false,
  canReadProviders: false,
  canReorderModels: false,
  canTestProvider: false,
  canUpdateModel: false,
  canUpdateProvider: false,
} satisfies AiCatalogPermissions;

describe('useGlobalModelActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rethrows create draft context failures so the Provider picker remains open', async () => {
    const failure = new Error('draft context unavailable');
    mocks.getCreateDraftContext.mockRejectedValue(failure);
    const { result } = renderHook(() => useGlobalModelActions({ authMethod: null, permissions }));

    await act(async () => {
      await expect(result.current.handleCreate('provider-empty')).rejects.toBe(failure);
    });

    expect(mocks.toastError).toHaveBeenCalledOnce();
    expect(mocks.openModelEditor).not.toHaveBeenCalled();
    expect(result.current.actionLoadingId).toBeNull();
  });
});
