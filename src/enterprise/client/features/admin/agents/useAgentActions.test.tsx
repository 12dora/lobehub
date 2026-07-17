// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveAdminAgentPermissions } from './controller';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';

const mocks = vi.hoisted(() => ({
  openReasonModal: vi.fn(),
  service: {
    appendVersion: vi.fn(),
    archive: vi.fn(),
    get: vi.fn(),
    publish: vi.fn(),
    rollback: vi.fn(),
    setDefaultInbox: vi.fn(),
  },
  fetchAllAdminAgents: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: mocks.openReasonModal,
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: mocks.service }));
vi.mock('./useAdminAgents', () => ({ fetchAllAdminAgents: mocks.fetchAllAdminAgents }));
vi.mock('@lobehub/ui', () => ({ Flexbox: () => null, Text: () => null }));
vi.mock('@lobehub/ui/base-ui', () => ({
  Select: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const snapshot = {
  assignments: [],
  draftToken: 'b'.repeat(64),
  identity: {
    agentKey: 'research',
    currentVersionId: 'v1',
    draftSequence: 1,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 7,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [],
} as unknown as AdminAgentDetailOutput;

const permissions = deriveAdminAgentPermissions([
  PLATFORM_PERMISSIONS.AGENT_PUBLISH,
  PLATFORM_PERMISSIONS.AGENT_UPDATE,
  PLATFORM_PERMISSIONS.AGENT_DELETE,
]);

const makeEditor = () =>
  ({
    conflict: false,
    dirty: true,
    discard: vi.fn(),
    draft: {
      config: { displayName: 'X' },
      dependencies: {
        connectors: [],
        model: {
          modelKey: 'm',
          providerChecksum: 'a'.repeat(64),
          providerKey: 'p',
          providerRevision: 1,
        },
        skills: [],
      },
      version: '1.0.1',
    },
    markSaved: vi.fn(),
    persistState: null,
    saveState: 'dirty',
    setConflict: vi.fn(),
    setSaveState: vi.fn(),
    updateDraft: vi.fn(),
  }) as any;

const lastModalConfig = () => mocks.openReasonModal.mock.calls.at(-1)![0];

describe('useAgentActions reauth + commit/refresh separation', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks.service)) fn.mockReset();
    mocks.openReasonModal.mockReset();
    mocks.fetchAllAdminAgents.mockReset().mockResolvedValue([]);
  });

  it('routes publish through the shared reauth modal with authMethod and a frozen CAS payload', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    mocks.service.publish.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
    const { result } = renderHook(() =>
      useAgentActions({
        authMethod: 'better-auth',
        editor: makeEditor(),
        mutate,
        permissions,
        snapshot,
      }),
    );

    act(() => result.current.publish('v1'));
    const config = lastModalConfig();
    expect(config.authMethod).toBe('better-auth');
    // Payload is frozen from the snapshot CAS, not regenerated.
    expect(config.buildPayload('do it')).toEqual({
      agentId: 'agent-1',
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 7,
      reason: 'do it',
      versionId: 'v1',
    });

    await act(async () => {
      await config.onSubmit(config.buildPayload('do it'));
    });
    expect(mocks.service.publish).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalled();
    expect(result.current.refreshFailed).toBe(false);
  });

  it('keeps a committed publish successful when the refresh fails (no duplicate mutation)', async () => {
    const mutate = vi.fn().mockRejectedValue(new Error('network'));
    mocks.service.publish.mockResolvedValue({ agentId: 'agent-1', revision: 8, versionId: 'v1' });
    const { result } = renderHook(() =>
      useAgentActions({ authMethod: null, editor: makeEditor(), mutate, permissions, snapshot }),
    );

    act(() => result.current.publish('v1'));
    const config = lastModalConfig();
    await act(async () => {
      // onSubmit must NOT throw — the commit succeeded, only the refresh failed.
      await config.onSubmit(config.buildPayload('reason'));
    });

    expect(mocks.service.publish).toHaveBeenCalledOnce();
    expect(result.current.refreshFailed).toBe(true);

    // Retrying the refresh recovers without re-running the mutation.
    mutate.mockResolvedValueOnce(undefined);
    await act(async () => {
      await result.current.retryRefresh();
    });
    expect(mocks.service.publish).toHaveBeenCalledOnce();
    expect(result.current.refreshFailed).toBe(false);
  });

  it('applies the authoritative appendVersion output locally after a committed save', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);
    const editor = makeEditor();
    mocks.service.appendVersion.mockResolvedValue({
      draftToken: 'c'.repeat(64),
      identity: { ...snapshot.identity, revision: 8 },
      version: { id: 'v2', version: '1.0.1' },
    });
    const { result } = renderHook(() =>
      useAgentActions({ authMethod: null, editor, mutate, permissions, snapshot }),
    );

    act(() => result.current.save());
    const config = lastModalConfig();
    await act(async () => {
      await config.onSubmit(config.buildPayload('save it'));
    });

    expect(mocks.service.appendVersion).toHaveBeenCalledOnce();
    expect(editor.markSaved).toHaveBeenCalledOnce();
    // Authoritative output applied locally with no revalidation.
    expect(mutate).toHaveBeenCalledWith(expect.any(Function), { revalidate: false });
  });
});
