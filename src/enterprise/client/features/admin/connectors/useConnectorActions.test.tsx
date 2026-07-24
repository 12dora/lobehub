import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminConnectorPermissions } from './controller';
import { resolveAdminConnectorPrimaryAction } from './controller';
import type { AdminConnectorGetOutput } from './types';
import { useConnectorActions } from './useConnectorActions';
import type { useConnectorEditor } from './useConnectorEditor';

const mocks = vi.hoisted(() => ({
  deleteDraft: vi.fn(async (..._args: unknown[]) => ({ auditId: 'audit-delete' })),
  mutate: vi.fn(async () => undefined as AdminConnectorGetOutput | undefined),
  navigate: vi.fn(),
  openReasonModal: vi.fn(),
  refreshAdminConnectorLists: vi.fn(async () => {}),
  t: vi.fn((key: string) => key),
  test: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  updateDraft: vi.fn(async (..._args: unknown[]) => ({
    auditId: 'audit-save',
    draftToken: 'd'.repeat(64),
  })),
}));

vi.mock('react-router', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: mocks.toast,
}));

vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: {
    deleteDraft: (...args: unknown[]) => mocks.deleteDraft(...args),
    test: (...args: unknown[]) => mocks.test(...args),
    updateDraft: (...args: unknown[]) => mocks.updateDraft(...args),
  },
}));

vi.mock('./useAdminConnectorCatalog', () => ({
  refreshAdminConnectorLists: () => mocks.refreshAdminConnectorLists(),
}));

const snapshot = (): AdminConnectorGetOutput => ({
  baseRevision: 3,
  draft: {
    connectionTest: null,
    credentialMode: 'none',
    description: null,
    displayName: 'Calendar',
    enabled: true,
    endpoint: 'https://calendar.example.com/mcp',
    id: 'connector-1',
    key: 'calendar',
    oauthClientSecret: { configured: false, fingerprint: null, updatedAt: null },
    oauthConfig: null,
    revision: 3,
    sharedSecret: { configured: false, fingerprint: null, updatedAt: null },
    sort: 0,
    status: 'draft',
    tools: [],
    transport: 'http',
  },
  draftToken: 'c'.repeat(64),
  published: null,
});

const permissions = (): AdminConnectorPermissions => ({
  canArchive: true,
  canCreate: true,
  canDelete: true,
  canDiscover: true,
  canPublish: true,
  canRead: true,
  canReadAudit: true,
  canRevokeBindings: true,
  canTest: true,
  canUpdate: true,
});

const idleEditor = (): ReturnType<typeof useConnectorEditor> =>
  ({
    actionError: null,
    changeSecret: vi.fn(),
    clearSecret: vi.fn(),
    conflict: false,
    dirty: false,
    discardLocal: vi.fn(),
    draft: {
      credentialMode: 'none',
      description: '',
      displayName: 'Calendar',
      enabled: true,
      endpoint: 'https://calendar.example.com/mcp',
      oauthAuthorizationEndpoint: '',
      oauthClientId: '',
      oauthIssuer: '',
      oauthScopes: '',
      oauthTokenEndpoint: '',
      sort: 0,
      tools: [],
    },
    keepSecret: vi.fn(),
    markSaved: vi.fn(),
    requiresSecretReentry: false,
    restoreNotice: null,
    saveState: 'idle',
    secret: { operation: 'keep', value: '' },
    setActionError: vi.fn(),
    setConflict: vi.fn(),
    setSaveState: vi.fn(),
    updateDraft: vi.fn(),
    updateTool: vi.fn(),
    validation: { errors: {}, valid: true },
  }) as unknown as ReturnType<typeof useConnectorEditor>;

describe('useConnectorActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openReasonModal.mockImplementation(({ onSubmit }) => {
      void onSubmit({ reason: 'test connection' });
    });
    mocks.mutate.mockResolvedValue(snapshot());
  });

  it('successful_test_retains_session_result_and_unlocks_publish_after_refetch', async () => {
    mocks.test.mockResolvedValue({
      errorCategory: null,
      latencyMs: 12,
      messageCode: 'connector.operation_succeeded',
      status: 'success',
      testedAt: new Date(),
    });

    const data = snapshot();
    // Server still projects null connectionTest after refetch.
    mocks.mutate.mockResolvedValue({
      ...data,
      draft: { ...data.draft, connectionTest: null },
    });

    const { result, rerender } = renderHook(
      ({ current }) =>
        useConnectorActions({
          authMethod: null,
          data: current,
          editor: idleEditor(),
          mutate: mocks.mutate,
          permissions: permissions(),
        }),
      { initialProps: { current: data } },
    );

    expect(result.current.primaryAction).toBe('test');

    await act(async () => {
      result.current.onPrimaryAction('test');
      // Allow openReasonModal async onSubmit to settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.test).toHaveBeenCalledWith({
      id: 'connector-1',
      reason: 'test connection',
    });
    expect(mocks.mutate).toHaveBeenCalled();

    // After refetch with connectionTest still null, session retention unlocks Publish.
    rerender({ current: { ...data, draft: { ...data.draft, connectionTest: null } } });
    expect(result.current.primaryAction).toBe('publish');
    expect(
      resolveAdminConnectorPrimaryAction({
        canPublish: true,
        canSave: true,
        canTest: true,
        conflict: false,
        dirty: false,
        saveFailed: false,
        testPassed: true,
      }),
    ).toBe('publish');
  });

  it('save_treats_mutation_as_success_when_only_cache_refresh_rejects', async () => {
    mocks.updateDraft.mockResolvedValueOnce({
      auditId: 'audit-save',
      draftToken: 'd'.repeat(64),
    });
    mocks.refreshAdminConnectorLists.mockRejectedValueOnce(new Error('swr revalidate failed'));
    mocks.mutate.mockRejectedValueOnce(new Error('detail revalidate failed'));

    const editor = idleEditor();
    editor.dirty = true as never;
    mocks.openReasonModal.mockImplementationOnce(({ onSubmit }) => {
      void onSubmit({
        displayName: 'Calendar',
        expectedDraftToken: 'c'.repeat(64),
        expectedRevision: 3,
        id: 'connector-1',
        reason: 'save draft',
      });
    });

    const { result } = renderHook(() =>
      useConnectorActions({
        authMethod: null,
        data: snapshot(),
        editor,
        mutate: mocks.mutate,
        permissions: permissions(),
      }),
    );

    await act(async () => {
      result.current.onPrimaryAction('save');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateDraft).toHaveBeenCalled();
    expect(editor.markSaved).toHaveBeenCalled();
    expect(editor.setSaveState).not.toHaveBeenCalledWith('failed');
    expect(mocks.toast.success).toHaveBeenCalledWith('connectorCatalog.toast.saved');
  });

  it('delete_navigates_after_commit_when_list_refresh_rejects', async () => {
    mocks.deleteDraft.mockResolvedValueOnce({ auditId: 'audit-delete' });
    mocks.refreshAdminConnectorLists.mockRejectedValueOnce(new Error('list revalidate failed'));
    mocks.openReasonModal.mockImplementationOnce(({ onSubmit }) => {
      void onSubmit({ id: 'connector-1', reason: 'delete draft' });
    });

    const editor = idleEditor();
    const { result } = renderHook(() =>
      useConnectorActions({
        authMethod: null,
        data: snapshot(),
        editor,
        mutate: mocks.mutate,
        permissions: permissions(),
      }),
    );

    await act(async () => {
      result.current.deleteDraft();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.deleteDraft).toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith('connectorCatalog.toast.deleted');
    expect(mocks.navigate).toHaveBeenCalledWith('/admin/connectors');
    expect(editor.setActionError).not.toHaveBeenCalled();
  });
});
