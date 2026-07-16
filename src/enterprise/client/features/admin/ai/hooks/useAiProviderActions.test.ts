import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCatalogPermissions, EditableAiProviderDraft } from '../controller';
import type { AdminAiModelDraft, AdminAiProviderGetOutput } from '../types';
import { useAiProviderActions } from './useAiProviderActions';

const mocks = vi.hoisted(() => ({
  dependents: vi.fn(),
  openModel: vi.fn(),
  openReason: vi.fn(),
  openSecret: vi.fn(),
  reasonProps: null as null | { onSubmit: (input: unknown) => Promise<void> },
  refresh: vi.fn(),
  testProvider: vi.fn(),
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
    getModelDependents: mocks.dependents,
    testProvider: mocks.testProvider,
  },
}));

vi.mock('../models/openModelEditorModal', () => ({ openModelEditorModal: mocks.openModel }));
vi.mock('../providers/openSecretMutationModal', () => ({
  openSecretMutationModal: mocks.openSecret,
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
  canCreateModel: true,
  canCreateProvider: false,
  canDeleteModel: true,
  canPublishModel: false,
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
    mocks.reasonProps = null;
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
});
