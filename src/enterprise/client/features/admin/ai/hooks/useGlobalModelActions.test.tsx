import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCatalogPermissions } from '../controller';
import { useGlobalModelActions } from './useGlobalModelActions';

const mocks = vi.hoisted(() => ({
  createModel: vi.fn(),
  deleteModel: vi.fn(),
  dependents: vi.fn(),
  getCreateDraftContext: vi.fn(),
  getDeleteDraftContext: vi.fn(),
  getUpdateDraftContext: vi.fn(),
  modelProps: null as null | { onSubmit: (input: never) => Promise<void> },
  openModelEditor: vi.fn(),
  openReason: vi.fn(),
  reasonProps: null as null | { onSubmit: (input: unknown) => Promise<void> },
  refresh: vi.fn(),
  reorderModels: vi.fn(),
  toastError: vi.fn(),
  updateModel: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: vi.fn(),
  toast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: (props: unknown) => {
    mocks.reasonProps = props as typeof mocks.reasonProps;
    mocks.openReason(props);
  },
}));

vi.mock('@/enterprise/client/services/adminAiCatalog', () => ({
  adminAiCatalogService: {
    createModel: mocks.createModel,
    deleteModel: mocks.deleteModel,
    getModelDependents: mocks.dependents,
    getModelCreateDraftContext: mocks.getCreateDraftContext,
    getModelDeleteDraftContext: mocks.getDeleteDraftContext,
    getModelUpdateDraftContext: mocks.getUpdateDraftContext,
    reorderModels: mocks.reorderModels,
    updateModel: mocks.updateModel,
  },
}));

vi.mock('../models/openModelEditorModal', () => ({
  openModelEditorModal: (props: unknown) => {
    mocks.modelProps = props as typeof mocks.modelProps;
    mocks.openModelEditor(props);
  },
}));

vi.mock('./useAdminAiCatalog', () => ({
  refreshAdminAiModelLists: mocks.refresh,
}));

const permissions = {
  canArchiveProvider: false,
  canDeleteProvider: false,
  canCreateModel: true,
  canCreateProvider: false,
  canDeleteModel: true,
  canPublishModel: false,
  canPublishProvider: false,
  canReadModels: true,
  canReadProviders: false,
  canReorderModels: true,
  canTestProvider: false,
  canUpdateModel: true,
  canUpdateProvider: false,
} satisfies AiCatalogPermissions;

const model = {
  abilities: {},
  config: null,
  contextWindowTokens: null,
  description: null,
  displayName: 'Model',
  enabled: true,
  id: 'model-1',
  modelKey: 'model-1',
  parameters: {},
  pricing: null,
  providerId: 'provider-1',
  providerKey: 'provider',
  revision: 1,
  settings: {},
  sort: 0,
  status: 'draft',
  type: 'chat',
} as const;

const context = {
  baseRevision: 1,
  draftToken: 'a'.repeat(64),
  modelIds: ['model-1', 'model-2'],
  providerId: 'provider-1',
};

describe('useGlobalModelActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modelProps = null;
    mocks.reasonProps = null;
    mocks.createModel.mockResolvedValue({});
    mocks.deleteModel.mockResolvedValue({});
    mocks.dependents.mockResolvedValue({ items: [] });
    mocks.getCreateDraftContext.mockResolvedValue(context);
    mocks.getDeleteDraftContext.mockResolvedValue(context);
    mocks.getUpdateDraftContext.mockResolvedValue(context);
    mocks.refresh.mockResolvedValue(undefined);
    mocks.reorderModels.mockResolvedValue({});
    mocks.updateModel.mockResolvedValue({});
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

  it('invalidates create, update, delete, and reorder modal submissions after a commit', async () => {
    mocks.refresh.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useGlobalModelActions({ authMethod: null, permissions }));

    await act(async () => result.current.handleCreate('provider-1'));
    const submitCommittedCreate = mocks.modelProps!.onSubmit;
    await act(async () => result.current.handleCreate('provider-1'));
    const submitStaleCreate = mocks.modelProps!.onSubmit;
    await act(async () => result.current.handleEdit(model));
    const submitStaleUpdate = mocks.modelProps!.onSubmit;
    await act(async () => result.current.handleDelete(model));
    const submitStaleDelete = mocks.reasonProps!.onSubmit;
    await act(async () => result.current.handleReorder(model, 1));
    const submitStaleReorder = mocks.reasonProps!.onSubmit;

    await act(async () =>
      submitCommittedCreate({ fields: {}, modelKey: 'new-model', reason: 'create' } as never),
    );
    await waitFor(() => expect(result.current.reloadRequired).toBe(true));

    await expect(submitStaleCreate({} as never)).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(submitStaleUpdate({} as never)).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(submitStaleDelete({})).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(submitStaleReorder({})).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    expect(mocks.createModel).toHaveBeenCalledOnce();
    expect(mocks.updateModel).not.toHaveBeenCalled();
    expect(mocks.deleteModel).not.toHaveBeenCalled();
    expect(mocks.reorderModels).not.toHaveBeenCalled();
  });

  it('does not open any model modal when another write commits during context queries', async () => {
    const { result } = renderHook(() => useGlobalModelActions({ authMethod: null, permissions }));
    await act(async () => result.current.handleCreate('provider-1'));
    const submitCommittedCreate = mocks.modelProps!.onSubmit;

    const contextResolvers: Array<(value: typeof context) => void> = [];
    const dependentsResolvers: Array<(value: { items: [] }) => void> = [];
    const deferredContext = () =>
      new Promise<typeof context>((resolve) => {
        contextResolvers.push(resolve);
      });
    mocks.getCreateDraftContext.mockImplementation(deferredContext);
    mocks.getDeleteDraftContext.mockImplementation(deferredContext);
    mocks.getUpdateDraftContext.mockImplementation(deferredContext);
    mocks.dependents.mockImplementation(
      () =>
        new Promise<{ items: [] }>((resolve) => {
          dependentsResolvers.push(resolve);
        }),
    );
    mocks.refresh.mockImplementation(() => new Promise(() => {}));
    mocks.openModelEditor.mockClear();
    mocks.openReason.mockClear();

    let pendingActions!: Array<Promise<void>>;
    act(() => {
      pendingActions = [
        result.current.handleCreate('provider-1'),
        result.current.handleEdit(model),
        result.current.handleDelete(model),
        result.current.handleReorder(model, 1),
      ];
    });
    await waitFor(() => expect(contextResolvers).toHaveLength(4));

    await act(async () =>
      submitCommittedCreate({ fields: {}, modelKey: 'new-model', reason: 'create' } as never),
    );
    contextResolvers.forEach((resolve) => resolve(context));
    dependentsResolvers.forEach((resolve) => resolve({ items: [] }));
    await act(async () => Promise.allSettled(pendingActions));

    expect(mocks.openModelEditor).not.toHaveBeenCalled();
    expect(mocks.openReason).not.toHaveBeenCalled();
  });
});
