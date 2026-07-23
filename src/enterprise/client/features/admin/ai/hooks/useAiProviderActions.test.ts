import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCatalogPermissions, EditableAiProviderDraft } from '../controller';
import type { AdminAiModelDraft, AdminAiProviderGetOutput } from '../types';
import { useAiProviderActions } from './useAiProviderActions';

const mocks = vi.hoisted(() => ({
  createModel: vi.fn(),
  deleteModel: vi.fn(),
  dependents: vi.fn(),
  modelProps: null as null | { onSubmit: (input: never) => Promise<void> },
  openModel: vi.fn(),
  openReason: vi.fn(),
  openSecret: vi.fn(),
  reasonProps: null as null | { onSubmit: (input: unknown) => Promise<void> },
  reorderModels: vi.fn(),
  refresh: vi.fn(),
  secretProps: null as null | { onSubmit: (input: never) => Promise<void> },
  testProvider: vi.fn(),
  updateModel: vi.fn(),
  updateProvider: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: (props: typeof mocks.reasonProps) => {
    mocks.reasonProps = props;
    mocks.openReason(props);
  },
}));

vi.mock('@/enterprise/client/services/adminAiCatalog', () => ({
  adminAiCatalogService: {
    createModel: mocks.createModel,
    deleteModel: mocks.deleteModel,
    getModelDependents: mocks.dependents,
    reorderModels: mocks.reorderModels,
    testProvider: mocks.testProvider,
    updateModel: mocks.updateModel,
    updateProvider: mocks.updateProvider,
  },
}));

vi.mock('../models/openModelEditorModal', () => ({
  openModelEditorModal: (props: unknown) => {
    mocks.modelProps = props as typeof mocks.modelProps;
    mocks.openModel(props);
  },
}));
vi.mock('../providers/openSecretMutationModal', () => ({
  openSecretMutationModal: (props: unknown) => {
    mocks.secretProps = props as typeof mocks.secretProps;
    mocks.openSecret(props);
  },
}));
vi.mock('./useAdminAiCatalog', () => ({ refreshAdminAiProvider: mocks.refresh }));

const draft: EditableAiProviderDraft = {
  checkModel: null,
  configText: '{}',
  description: null,
  displayName: 'Provider',
  enabled: true,
  fetchOnClient: false,
  logo: null,
  settingsText: '{}',
  sort: 0,
};

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
  revision: 1,
  settings: {},
  sort: 0,
  status: 'draft',
  type: 'chat',
} satisfies AdminAiModelDraft;

const data = {
  baseRevision: 1,
  draft: {
    checkModel: null,
    config: {},
    connectionTest: null,
    description: null,
    displayName: 'Provider',
    enabled: true,
    fetchOnClient: false,
    id: 'provider-1',
    logo: null,
    models: [model],
    providerKey: 'provider',
    revision: 1,
    secret: { configured: true, fingerprint: 'safe-fingerprint', updatedAt: null },
    settings: {},
    sort: 0,
    source: 'custom',
    status: 'draft',
  },
  draftToken: 'a'.repeat(64),
  published: null,
} satisfies AdminAiProviderGetOutput;

const permissions: AiCatalogPermissions = {
  canArchiveProvider: true,
  canDeleteProvider: true,
  canCreateModel: true,
  canCreateProvider: false,
  canDeleteModel: true,

  canPublishProvider: true,
  canReadModels: true,
  canReadProviders: true,
  canReorderModels: true,
  canTestProvider: true,
  canUpdateModel: true,
  canUpdateProvider: true,
};

const editor = {
  actionError: null,
  conflict: false,
  connectionTest: { canPublish: false, stale: false, state: null },
  dirty: false,
  draft,
  invalidateTest: vi.fn(),
  markSaved: vi.fn(),
  saveState: 'idle',
  setActionError: vi.fn(),
  setConflict: vi.fn(),
  setSaveState: vi.fn(),
  valid: true,
} as never;

describe('useAiProviderActions committed reload lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modelProps = null;
    mocks.reasonProps = null;
    mocks.secretProps = null;
    mocks.createModel.mockResolvedValue({});
    mocks.deleteModel.mockResolvedValue({});
    mocks.reorderModels.mockResolvedValue({});
    mocks.updateModel.mockResolvedValue({});
    mocks.updateProvider.mockResolvedValue({});
    mocks.testProvider.mockResolvedValue({
      errorCategory: null,
      latencyMs: 1,
      sanitizedMessage: 'ok',
      status: 'success',
      testedAt: new Date(0),
    });
  });

  it('does not open any Provider write action while committed refresh is deferred', async () => {
    let finishRefresh!: (value: AdminAiProviderGetOutput) => void;
    mocks.refresh.mockImplementation(
      () =>
        new Promise<AdminAiProviderGetOutput>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useAiProviderActions({ authMethod: null, data, editor, permissions }),
    );

    act(() => result.current.handlePrimary());
    await act(async () => mocks.reasonProps!.onSubmit({ id: 'provider-1', reason: 'test' }));
    await waitFor(() => expect(result.current.reloadRequired).toBe(true));

    mocks.openReason.mockClear();
    mocks.openSecret.mockClear();
    mocks.openModel.mockClear();
    act(() => {
      result.current.handlePrimary();
      result.current.handleSecret();
      result.current.handleArchive();
      result.current.handleRollback(1);
      result.current.handleCreateModel();
      result.current.handleReorderModels(['model-1']);
    });
    await act(async () => {
      await result.current.handleEditModel(model);
      await result.current.handleDeleteModel(model);
    });

    expect(mocks.openReason).not.toHaveBeenCalled();
    expect(mocks.openSecret).not.toHaveBeenCalled();
    expect(mocks.openModel).not.toHaveBeenCalled();
    expect(mocks.dependents).not.toHaveBeenCalled();

    finishRefresh({ ...data, draftToken: 'b'.repeat(64) });
    await waitFor(() => expect(result.current.reloadRequired).toBe(false));
  });

  it('invalidates create, update, delete, and reorder modal submissions after another commit', async () => {
    mocks.dependents.mockResolvedValue({ items: [] });
    mocks.refresh.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useAiProviderActions({ authMethod: null, data, editor, permissions }),
    );

    act(() => result.current.handleCreateModel());
    const submitCreate = mocks.modelProps!.onSubmit;

    await act(async () => result.current.handleEditModel(model));
    const submitUpdate = mocks.modelProps!.onSubmit;

    await act(async () => result.current.handleDeleteModel(model));
    const submitDelete = mocks.reasonProps!.onSubmit;

    act(() => result.current.handleReorderModels(['model-1']));
    const submitReorder = mocks.reasonProps!.onSubmit;

    act(() => result.current.handleSecret());
    await act(async () =>
      mocks.secretProps!.onSubmit({ reason: 'rotate', secret: { operation: 'clear' } } as never),
    );
    await waitFor(() => expect(result.current.reloadRequired).toBe(true));

    await expect(submitCreate({} as never)).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(submitUpdate({} as never)).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(submitDelete({})).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    await expect(submitReorder({})).rejects.toThrow('PLATFORM_REVISION_CONFLICT');
    expect(mocks.createModel).not.toHaveBeenCalled();
    expect(mocks.updateModel).not.toHaveBeenCalled();
    expect(mocks.deleteModel).not.toHaveBeenCalled();
    expect(mocks.reorderModels).not.toHaveBeenCalled();
  });

  it('does not open update or delete modals when another write commits during dependents queries', async () => {
    const dependentsResolvers: Array<(value: { items: [] }) => void> = [];
    mocks.dependents.mockImplementation(
      () =>
        new Promise<{ items: [] }>((resolve) => {
          dependentsResolvers.push(resolve);
        }),
    );
    mocks.refresh.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() =>
      useAiProviderActions({ authMethod: null, data, editor, permissions }),
    );

    let editPromise!: Promise<void>;
    let deletePromise!: Promise<void>;
    act(() => {
      editPromise = result.current.handleEditModel(model);
      deletePromise = result.current.handleDeleteModel(model);
    });
    await waitFor(() => expect(mocks.dependents).toHaveBeenCalledTimes(2));

    act(() => result.current.handleSecret());
    await act(async () =>
      mocks.secretProps!.onSubmit({ reason: 'rotate', secret: { operation: 'clear' } } as never),
    );
    dependentsResolvers.forEach((resolve) => resolve({ items: [] }));
    await act(async () => Promise.all([editPromise, deletePromise]));

    expect(mocks.openModel).not.toHaveBeenCalled();
    expect(mocks.openReason).not.toHaveBeenCalled();
  });
});
