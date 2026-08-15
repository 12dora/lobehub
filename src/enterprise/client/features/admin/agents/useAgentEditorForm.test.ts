// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAgentDetailOutput } from './types';
import { seedAgentEditorValue, suggestAgentKey, useAgentEditorForm } from './useAgentEditorForm';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  save: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: vi.fn(), success: mocks.toastSuccess, warning: mocks.toastWarning },
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { create: mocks.create, save: mocks.save },
}));
vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  // The reauth retry wrapper is exercised by its own tests; here it must stay transparent.
  withAdminReauthRetry: (fn: () => Promise<unknown>) => fn(),
}));

const model = {
  modelKey: 'gpt-4.1',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'openai',
  providerRevision: 4,
};

const config = {
  avatar: null,
  backgroundColor: '#4f46e5',
  description: 'Research synthesis.',
  displayName: 'Research Assistant',
  modelParameters: { temperature: 0.3 },
  openingMessage: null,
  openingQuestions: ['Compare these sources'],
  systemRole: 'Synthesize evidence.',
  tags: ['research'],
};

const agent = {
  assignments: [],
  draftToken: 'b'.repeat(64),
  identity: {
    agentKey: 'research-assistant',
    currentVersionId: 'version-1',
    draftSequence: 3,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision: 7,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [
    {
      agentId: 'agent-1',
      checksum: 'c'.repeat(64),
      config,
      createdAt: new Date('2026-07-17T00:00:00Z'),
      createdBy: 'admin-1',
      dependencySnapshot: { connectors: [], model, skills: [] },
      id: 'version-1',
      version: '1.0.0',
    },
  ],
} as unknown as AdminAgentDetailOutput;

const READY = { blockers: [], issues: [], ready: true };

/** Only the fields the editor itself reads; the full contract shape is covered by the mock client. */
const createdOutput = { identity: { id: 'agent-new' }, invalidationStatus: 'delivered' };
const savedOutput = { identity: { id: 'agent-1' }, invalidationStatus: 'delivered' };

beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue(createdOutput);
  mocks.save.mockReset().mockResolvedValue(savedOutput);
  mocks.toastSuccess.mockReset();
  mocks.toastWarning.mockReset();
});

describe('suggestAgentKey', () => {
  it.each([
    ['Research Assistant', 'research-assistant'],
    ['  产品 Copilot  ', 'copilot'],
    ['A///B', 'a-b'],
  ])('derives a contract-legal identifier from %s', (name, expected) => {
    expect(suggestAgentKey(name)).toBe(expected);
    if (expected) expect(expected).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });
});

describe('seedAgentEditorValue', () => {
  it('seeds the LIVE published version, not the newest appended one', () => {
    const withNewer = {
      ...agent,
      versions: [
        {
          ...agent.versions[0],
          config: { ...config, displayName: 'Newer but unpublished' },
          createdAt: new Date('2026-07-18T00:00:00Z'),
          id: 'version-2',
          version: '1.0.1',
        },
        ...agent.versions,
      ],
    } as AdminAgentDetailOutput;
    expect(seedAgentEditorValue(withNewer).config.displayName).toBe('Research Assistant');
  });

  it('starts empty for create', () => {
    expect(seedAgentEditorValue(undefined)).toEqual({
      config: {
        avatar: null,
        backgroundColor: null,
        description: null,
        displayName: '',
        modelParameters: {},
        openingMessage: null,
        openingQuestions: [],
        systemRole: '',
        tags: [],
      },
      dependencies: { connectors: [], model: null, skills: [] },
    });
  });
});

describe('useAgentEditorForm create', () => {
  it('suggests the identifier from the name until the admin edits it by hand', () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('Support Agent'));
    expect(result.current.agentKey).toBe('support-agent');

    act(() => result.current.changeAgentKey('support-desk'));
    act(() => result.current.setDisplayName('Support Agent v2'));
    expect(result.current.agentKey).toBe('support-desk');
  });

  it('creates and publishes in one call once the required fields and model are set', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { result } = renderHook(() => useAgentEditorForm({ onClose, onSaved }));

    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.patchConfig('systemRole', 'Help members with support.'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    // Nothing is submittable until the dependency catalog reports a settled, current selection.
    expect(result.current.canSubmit).toBe(false);
    act(() => result.current.setDepValidity(READY));
    expect(result.current.canSubmit).toBe(true);

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.create).toHaveBeenCalledWith({
      agentKey: 'support-agent',
      config: expect.objectContaining({
        displayName: 'Support Agent',
        systemRole: 'Help members with support.',
      }),
      dependencySnapshot: { connectors: [], model, skills: [] },
      isDefault: false,
      reason: expect.any(String),
      systemKey: null,
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.toast.created');
    expect(onSaved).toHaveBeenCalledWith(createdOutput, true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('warns instead of claiming success when the invalidation is only deferred', async () => {
    mocks.create.mockResolvedValue({ ...createdOutput, invalidationStatus: 'deferred' });
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.patchConfig('systemRole', 'Help members with support.'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => result.current.setDepValidity(READY));

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.toast.refreshDeferred');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('refuses an identifier past the contract length ceiling but accepts one exactly at it', () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.changeAgentKey('a'.repeat(128)));
    expect(result.current.keyValid).toBe(true);

    act(() => result.current.changeAgentKey('a'.repeat(129)));
    expect(result.current.keyValid).toBe(false);
    expect(result.current.canSubmit).toBe(false);
  });

  it('blocks an incomplete form at the submit boundary without touching the service', async () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => result.current.setDepValidity(READY));

    // No system role → the contract config cannot be built.
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.current.error).toBe('agentCatalog.save.invalid');
  });

  it('refuses an identifier the contract would reject', () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.patchConfig('systemRole', 'Help.'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.changeAgentKey('-nope'));

    expect(result.current.keyValid).toBe(false);
    expect(result.current.canSubmit).toBe(false);
  });
});

describe('useAgentEditorForm edit', () => {
  it('saves against the exact CAS carried by the loaded aggregate', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const dirtyRef = { current: false };
    const { result } = renderHook(() => useAgentEditorForm({ agent, dirtyRef, onClose, onSaved }));

    // Seeded from the live version, so nothing is dirty and Save stays closed.
    expect(result.current.value.config.displayName).toBe('Research Assistant');
    act(() => result.current.setDepValidity(READY));
    expect(result.current.dirty).toBe(false);
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.setDisplayName('Research Assistant v2'));
    expect(result.current.dirty).toBe(true);
    expect(dirtyRef.current).toBe(true);
    expect(result.current.canSubmit).toBe(true);

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.save).toHaveBeenCalledWith({
      agentId: 'agent-1',
      config: expect.objectContaining({ displayName: 'Research Assistant v2' }),
      dependencySnapshot: { connectors: [], model, skills: [] },
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 7,
      reason: expect.any(String),
    });
    // No client-side version label — the server generates it.
    expect(mocks.save.mock.calls[0]![0]).not.toHaveProperty('version');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.toast.saved');
    expect(onSaved).toHaveBeenCalledWith(savedOutput, false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(dirtyRef.current).toBe(false);
  });

  it('warns about a deferred invalidation instead of reporting a clean save', async () => {
    mocks.save.mockResolvedValue({ ...savedOutput, invalidationStatus: 'deferred' });
    const { result } = renderHook(() => useAgentEditorForm({ agent }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.toast.refreshDeferred');
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('holds the dismissal guard for the whole in-flight write, then releases it on commit', async () => {
    let commit!: (value: unknown) => void;
    mocks.save.mockReturnValue(
      new Promise((resolve) => {
        commit = resolve;
      }),
    );
    const dirtyRef = { current: false };
    const pendingRef = { current: false };
    const { result } = renderHook(() =>
      useAgentEditorForm({ agent, dirtyRef, pendingRef, onClose: vi.fn() }),
    );
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));

    let submitted!: Promise<void>;
    act(() => {
      submitted = result.current.submit();
    });
    // Mid-write: the modal must veto Escape / X, so the guard is set and the input is still unsaved.
    expect(pendingRef.current).toBe(true);
    expect(dirtyRef.current).toBe(true);

    await act(async () => {
      commit(savedOutput);
      await submitted;
    });
    expect(pendingRef.current).toBe(false);
    expect(dirtyRef.current).toBe(false);
  });

  it('keeps the unsaved guard armed when the write fails mid-flight', async () => {
    mocks.save.mockRejectedValue(new Error('offline'));
    const dirtyRef = { current: false };
    const pendingRef = { current: false };
    const { result } = renderHook(() => useAgentEditorForm({ agent, dirtyRef, pendingRef }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));

    await act(async () => {
      await result.current.submit();
    });

    expect(pendingRef.current).toBe(false);
    expect(dirtyRef.current).toBe(true); // nothing committed — the input is still unsaved
  });

  it('normalizes empty and duplicate values into the contract shape', async () => {
    const { result } = renderHook(() => useAgentEditorForm({ agent }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.patchConfig('description', '   '));
    act(() => result.current.patchConfig('openingQuestions', ['a', '', ' a ', 'b']));
    act(() => result.current.patchConfig('backgroundColor', 'rgba(0, 0, 0, 0)'));

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.save.mock.calls[0]![0].config).toMatchObject({
      backgroundColor: null,
      description: null,
      openingQuestions: ['a', 'b'],
    });
  });

  it('keeps the modal open with a conflict notice when another admin saved first', async () => {
    const onClose = vi.fn();
    mocks.save.mockRejectedValue(new Error('PLATFORM_REVISION_CONFLICT'));
    const { result } = renderHook(() => useAgentEditorForm({ agent, onClose }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.conflict).toBe(true);
    expect(result.current.error).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.saving).toBe(false);
  });

  it('closes but WARNS when the caller could not apply/refresh the committed save', async () => {
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useAgentEditorForm({
        agent,
        onClose,
        onSaved: () => Promise.reject(new Error('revalidate failed')),
      }),
    );
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.save).toHaveBeenCalledOnce();
    // The write committed, so the modal still closes — but the stale screen is never silent.
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.recovery.refreshFailed');
    expect(result.current.conflict).toBe(false);
  });
});
