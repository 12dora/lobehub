// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAssignmentPlan, classifySubmitFailure } from './agentEditorSubmit';
import type { AssignmentPlan } from './assignmentDraft';
import type { AdminAgentDetailOutput } from './types';
import { seedAgentEditorValue, suggestAgentKey, useAgentEditorForm } from './useAgentEditorForm';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fetchDetail: vi.fn(),
  list: vi.fn(),
  order: [] as string[],
  removeAssignment: vi.fn(),
  save: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  upsertAssignment: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { error: vi.fn(), success: mocks.toastSuccess, warning: mocks.toastWarning },
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    create: mocks.create,
    list: mocks.list,
    removeAssignment: mocks.removeAssignment,
    save: mocks.save,
    upsertAssignment: mocks.upsertAssignment,
  },
}));
// The post-failure reconcile reads the authoritative aggregate through this helper.
vi.mock('./useAdminAgents', () => ({
  fetchAdminAgentDetail: (...args: unknown[]) => mocks.fetchDetail(...args),
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

const ASSIGNMENT = {
  agentId: 'agent-1',
  enabled: true,
  id: 'assignment-1',
  mode: 'optional' as const,
  pinnedVersionId: null,
  targetId: 'user-1',
  targetType: 'user' as const,
  versionPolicy: 'latest_published' as const,
};

/** An aggregate that already carries one assignment, as the list page loads it. */
const assignedAgent = { ...agent, assignments: [ASSIGNMENT] } as unknown as AdminAgentDetailOutput;

/** Only the fields the editor itself reads; the full contract shape is covered by the mock client. */
const createdOutput = {
  draftToken: 'c'.repeat(64),
  identity: { id: 'agent-new', revision: 1 },
  invalidationStatus: 'delivered',
};
const savedOutput = {
  draftToken: 'd'.repeat(64),
  identity: { id: 'agent-1', revision: 8 },
  invalidationStatus: 'delivered',
};

beforeEach(() => {
  mocks.order = [];
  mocks.create.mockReset().mockImplementation(async () => {
    mocks.order.push('create');
    return createdOutput;
  });
  mocks.save.mockReset().mockImplementation(async () => {
    mocks.order.push('save');
    return savedOutput;
  });
  mocks.removeAssignment.mockReset().mockImplementation(async ({ assignmentId }) => {
    mocks.order.push(`remove:${assignmentId}`);
    return { draftToken: 'r'.repeat(64), identity: { revision: 20 }, removed: true };
  });
  mocks.upsertAssignment.mockReset().mockImplementation(async ({ targetId }) => {
    mocks.order.push(`upsert:${targetId}`);
    return {
      assignment: { ...ASSIGNMENT, id: `assignment-${targetId}`, targetId },
      draftToken: 'u'.repeat(64),
      identity: { revision: 21 },
    };
  });
  mocks.toastSuccess.mockReset();
  mocks.toastWarning.mockReset();
  // What a reconcile read would find. Tests set this to whatever actually committed before the
  // transport gave up, which is the entire point of reconciling instead of assuming.
  server.assignments = [];
  server.config = config;
  mocks.fetchDetail.mockReset().mockImplementation(async (id: string) => ({
    ...agent,
    assignments: server.assignments,
    identity: { ...agent.identity, id, revision: 20 },
    versions: [{ ...agent.versions[0], config: server.config }],
  }));
  mocks.list.mockReset().mockResolvedValue({ items: [], nextCursor: null });
});

/** The authoritative state a reconcile read returns; mutated per test. */
const server: { assignments: unknown[]; config: unknown } = { assignments: [], config };

describe('suggestAgentKey', () => {
  it.each([
    ['Research Assistant', 'research-assistant'],
    ['  产品 Copilot  ', 'copilot'],
    ['助理 Copilot', 'copilot'],
    ['A///B', 'a-b'],
    // Nothing in the contract charset survives an all-CJK name — the suggestion has no answer.
    ['测试助理', ''],
    ['助理', ''],
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

  it('prefills a LEGAL identifier for a name the charset cannot carry, instead of an empty one', () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('测试助理'));

    // The derived suggestion is empty and illegal — Save would have been dead with nothing to fix.
    expect(suggestAgentKey('测试助理')).toBe('');
    expect(result.current.agentKey).toMatch(/^assistant-[\da-z]{6}$/);
    expect(result.current.keyValid).toBe(true);

    // Stable while the admin keeps typing: the identifier is permanent after create.
    const prefilled = result.current.agentKey;
    act(() => result.current.setDisplayName('测试助理二号'));
    expect(result.current.agentKey).toBe(prefilled);

    // Clearing the name clears the identifier again rather than stranding a generated one.
    act(() => result.current.setDisplayName(''));
    expect(result.current.agentKey).toBe('');
  });

  it('names every required field that is still missing, and stops once they are filled', () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    expect(result.current.missingRequirements).toEqual([
      'agentCatalog.editor.missing.name',
      'agentCatalog.editor.missing.key',
      'agentCatalog.editor.missing.model',
    ]);

    act(() => result.current.setDisplayName('Support Agent'));
    expect(result.current.missingRequirements).toEqual(['agentCatalog.editor.missing.model']);

    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    expect(result.current.missingRequirements).toEqual([]);
  });

  it('counts an identifier the admin cleared by hand as missing', () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.changeAgentKey(''));
    expect(result.current.missingRequirements).toContain('agentCatalog.editor.missing.key');
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
      systemKey: null,
    });
    // Creating an assistant is an ordinary authoring save — no synthetic audit reason is sent.
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('reason');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.toast.created');
    expect(onSaved).toHaveBeenCalledWith(createdOutput, {
      assignmentsChanged: false,
      created: true,
    });
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
    act(() => result.current.changeAgentKey('support-agent'));
    act(() => result.current.patchConfig('systemRole', 'Help members with support.'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => result.current.setDepValidity(READY));

    // No display name → the contract config cannot be built.
    expect(result.current.missingRequirements).toEqual(['agentCatalog.editor.missing.name']);
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.current.error).toBe('agentCatalog.save.invalid');
  });

  it('publishes an assistant with NO system prompt — the contract allows an empty one', async () => {
    const { result } = renderHook(() => useAgentEditorForm({}));
    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => result.current.setDepValidity(READY));

    // Nothing is outstanding: the prompt is optional for every assistant, not just the default.
    expect(result.current.missingRequirements).toEqual([]);
    expect(result.current.canSubmit).toBe(true);

    await act(async () => {
      await result.current.submit();
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ displayName: 'Support Agent', systemRole: '' }),
      }),
    );
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
    });
    // Saving an assistant is an ordinary authoring save — no synthetic audit reason is sent.
    expect(mocks.save.mock.calls[0]![0]).not.toHaveProperty('reason');
    // No client-side version label — the server generates it.
    expect(mocks.save.mock.calls[0]![0]).not.toHaveProperty('version');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.toast.saved');
    expect(onSaved).toHaveBeenCalledWith(savedOutput, {
      assignmentsChanged: false,
      created: false,
    });
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

describe('useAgentEditorForm assignment chain', () => {
  const withAssignment = () =>
    renderHook(() => useAgentEditorForm({ agent: assignedAgent, canAssign: true }));

  it('writes nothing about assignments when the operator has no assign grant', async () => {
    const { result } = renderHook(() => useAgentEditorForm({ agent: assignedAgent }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));
    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.upsertAssignment).not.toHaveBeenCalled();
    expect(mocks.removeAssignment).not.toHaveBeenCalled();
    // The section is not even rendered, so its state must stay empty.
    expect(result.current.assignments.entries).toEqual([]);
  });

  it('opens Save for an assignment-only change and skips the version write entirely', async () => {
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useAgentEditorForm({ agent: assignedAgent, canAssign: true, onSaved }),
    );
    act(() => result.current.setDepValidity(READY));
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.assignments.patchDraft('targetType', 'global_role'));
    act(() => result.current.assignments.patchDraft('targetId', 'role-a'));
    act(() => result.current.assignments.add());
    expect(result.current.dirty).toBe(true);
    expect(result.current.canSubmit).toBe(true);

    await act(async () => {
      await result.current.submit();
    });

    // Nothing about the assistant changed, so no new immutable version is appended.
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.upsertAssignment).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith(null, { assignmentsChanged: true, created: false });
  });

  it('removes before it upserts, chaining the CAS each write hands back', async () => {
    const { result } = withAssignment();
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.assignments.remove(result.current.assignments.entries[0]!));
    act(() => result.current.assignments.patchDraft('targetType', 'user'));
    act(() => result.current.assignments.patchDraft('targetId', 'user-2'));
    act(() => result.current.assignments.add());
    act(() => result.current.setDisplayName('Research Assistant v2'));

    await act(async () => {
      await result.current.submit();
    });

    // A dropped-then-re-added target would collide with the unique index in the other order.
    expect(mocks.order).toEqual(['save', 'remove:assignment-1', 'upsert:user-2']);
    // The save's CAS feeds the removal, and the removal's CAS feeds the upsert — no re-GET.
    expect(mocks.removeAssignment.mock.calls[0]![0]).toMatchObject({
      expectedDraftToken: savedOutput.draftToken,
      expectedRevision: savedOutput.identity.revision,
    });
    expect(mocks.upsertAssignment.mock.calls[0]![0]).toMatchObject({
      expectedDraftToken: 'r'.repeat(64),
      expectedRevision: 20,
      pinnedVersionId: null,
      versionPolicy: 'latest_published',
    });
  });

  it('keeps the modal open and names the partial state when a chained write fails', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    mocks.upsertAssignment.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() =>
      useAgentEditorForm({ agent: assignedAgent, canAssign: true, onClose, onSaved }),
    );
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));
    act(() => result.current.assignments.patchDraft('targetType', 'user'));
    act(() => result.current.assignments.patchDraft('targetId', 'user-2'));
    act(() => result.current.assignments.add());

    await act(async () => {
      await result.current.submit();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.conflict).toBe(false);
    expect(result.current.error).toContain('agentCatalog.assignment.partialFailure');
    // The version DID commit, so the caller is told — its list row would otherwise stay stale.
    expect(onSaved).toHaveBeenCalledWith(savedOutput, {
      assignmentsChanged: true,
      created: false,
    });
  });

  it('retries only what is left after a partial failure, against the advanced CAS', async () => {
    mocks.upsertAssignment.mockRejectedValueOnce(new Error('offline'));
    // The save and the removal DID land; only the upsert never reached the server.
    server.config = { ...config, displayName: 'Research Assistant v2' };
    server.assignments = [];
    const { result } = withAssignment();
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));
    act(() => result.current.assignments.remove(result.current.assignments.entries[0]!));
    act(() => result.current.assignments.patchDraft('targetType', 'user'));
    act(() => result.current.assignments.patchDraft('targetId', 'user-2'));
    act(() => result.current.assignments.add());

    await act(async () => {
      await result.current.submit();
    });
    // The upsert rejected before it could record itself — save and the removal did land.
    expect(mocks.order).toEqual(['save', 'remove:assignment-1']);

    await act(async () => {
      await result.current.submit();
    });
    // No second version, no replayed removal — only the write that never landed.
    expect(mocks.order).toEqual(['save', 'remove:assignment-1', 'upsert:user-2']);
    // The retry writes against the CAS the RECONCILE read returned — not the stale in-flight one.
    expect(mocks.upsertAssignment.mock.calls.at(-1)![0]).toMatchObject({
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 20,
    });
    expect(result.current.error).toBeNull();
    expect(result.current.dirty).toBe(false);
  });

  it('resumes a create whose assignment chain failed without creating a second assistant', async () => {
    mocks.upsertAssignment.mockRejectedValueOnce(new Error('offline'));
    // The create landed; the reconcile read must recognise the config as already live.
    server.config = {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: 'Support Agent',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: 'Help members with support.',
      tags: [],
    };
    const { result } = renderHook(() => useAgentEditorForm({ canAssign: true }));
    act(() => result.current.setDisplayName('Support Agent'));
    act(() => result.current.patchConfig('systemRole', 'Help members with support.'));
    act(() => result.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.assignments.add());

    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(result.current.error).toContain('agentCatalog.assignment.partialFailure');

    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.upsertAssignment).toHaveBeenCalledTimes(2);
    expect(mocks.upsertAssignment.mock.calls.at(-1)![0]).toMatchObject({
      agentId: 'agent-new',
      expectedDraftToken: 'b'.repeat(64),
    });
  });
});

describe('useAgentEditorForm ambiguous failure (server side effect, then transport rejection)', () => {
  const filledCreate = (hook: { current: ReturnType<typeof useAgentEditorForm> }) => {
    act(() => hook.current.setDisplayName('Support Agent'));
    act(() => hook.current.patchConfig('systemRole', 'Help members with support.'));
    act(() => hook.current.setDependencies({ connectors: [], model, skills: [] }));
    act(() => hook.current.setDepValidity(READY));
  };

  it('never creates a second assistant when the CREATE committed but its response was lost', async () => {
    mocks.create.mockRejectedValueOnce(new Error('socket hang up'));
    // The row IS on the server — a blind retry would author a duplicate assistant.
    mocks.list.mockResolvedValue({
      items: [{ identity: { agentKey: 'support-agent', id: 'agent-new' } }],
      nextCursor: null,
    });
    server.config = {
      avatar: null,
      backgroundColor: null,
      description: null,
      displayName: 'Support Agent',
      modelParameters: {},
      openingMessage: null,
      openingQuestions: [],
      systemRole: 'Help members with support.',
      tags: [],
    };

    const { result } = renderHook(() => useAgentEditorForm({ canAssign: true }));
    filledCreate(result);
    act(() => result.current.assignments.add());

    await act(async () => {
      await result.current.submit();
    });

    // The reconcile looked the assistant up by its unique key rather than assuming.
    expect(mocks.list).toHaveBeenCalledWith({ limit: 100, query: 'support-agent' });
    expect(result.current.resumeBlocked).toBe(false);
    expect(result.current.error).toContain('agentCatalog.assignment.partialFailure');

    await act(async () => {
      await result.current.submit();
    });
    // One create, ever. The resume writes the assignment against the reconciled CAS.
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.upsertAssignment.mock.calls.at(-1)![0]).toMatchObject({ agentId: 'agent-new' });
  });

  it('treats a CREATE the key lookup cannot find as never having happened', async () => {
    mocks.create.mockRejectedValueOnce(new Error('socket hang up'));
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });

    const { result } = renderHook(() => useAgentEditorForm({}));
    filledCreate(result);

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.resumeBlocked).toBe(false);
    expect(result.current.error).toBeTruthy();

    await act(async () => {
      await result.current.submit();
    });
    // Nothing was committed, so the retry legitimately creates.
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('blocks the resume when it cannot tell whether the create landed', async () => {
    mocks.create.mockRejectedValueOnce(new Error('socket hang up'));
    mocks.list.mockRejectedValue(new Error('still offline'));

    const { result } = renderHook(() => useAgentEditorForm({}));
    filledCreate(result);

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.resumeBlocked).toBe(true);
    expect(result.current.error).toBe('agentCatalog.editor.resumeBlocked');
    expect(result.current.canSubmit).toBe(false);

    // Save is closed: a blind retry here is exactly how a duplicate assistant gets created.
    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('does not replay an UPSERT whose response was lost but whose row already exists', async () => {
    mocks.upsertAssignment.mockRejectedValueOnce(new Error('socket hang up'));
    server.config = config;
    // The assignment IS on the server; only the acknowledgement was lost.
    server.assignments = [
      {
        agentId: 'agent-1',
        enabled: true,
        id: 'assignment-landed',
        mode: 'optional',
        pinnedVersionId: null,
        targetId: 'user-2',
        targetType: 'user',
        versionPolicy: 'latest_published',
      },
    ];

    const { result } = renderHook(() =>
      useAgentEditorForm({ agent: assignedAgent, canAssign: true }),
    );
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.assignments.remove(result.current.assignments.entries[0]!));
    act(() => result.current.assignments.patchDraft('targetType', 'user'));
    act(() => result.current.assignments.patchDraft('targetId', 'user-2'));
    act(() => result.current.assignments.add());

    await act(async () => {
      await result.current.submit();
    });
    expect(mocks.upsertAssignment).toHaveBeenCalledOnce();

    // The reconcile adopted the committed row's id, so there is nothing left to write.
    expect(result.current.assignments.entries.map(({ id }) => id)).toEqual(['assignment-landed']);
    expect(result.current.assignments.dirty).toBe(false);
    expect(result.current.canSubmit).toBe(false);
  });

  it('leaves a REVISION CONFLICT alone — the server already said it refused the write', async () => {
    mocks.save.mockRejectedValue(new Error('PLATFORM_REVISION_CONFLICT'));
    const { result } = renderHook(() => useAgentEditorForm({ agent: assignedAgent }));
    act(() => result.current.setDepValidity(READY));
    act(() => result.current.setDisplayName('Research Assistant v2'));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.conflict).toBe(true);
    expect(result.current.resumeBlocked).toBe(false);
    // No reconcile read: a conflict is a definitive "did not commit", not an ambiguous failure.
    expect(mocks.fetchDetail).not.toHaveBeenCalled();
  });
});

describe('classifySubmitFailure', () => {
  const cas = { agentId: 'agent-1', draftToken: 'b'.repeat(64), revision: 7 };
  const conflict = new Error('PLATFORM_REVISION_CONFLICT');
  const transport = new Error('socket hang up');

  it('treats a revision conflict as a definitive non-commit and does not reconcile', async () => {
    const reconcile = vi.fn();
    await expect(
      classifySubmitFailure({
        cas,
        cause: conflict,
        created: false,
        identityCommitted: false,
        reconcile,
      }),
    ).resolves.toBe('conflict');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('blocks resume when a create may have landed but reconcile cannot tell', async () => {
    const reconcile = vi.fn().mockResolvedValue('unknown');
    await expect(
      classifySubmitFailure({
        cas: null,
        cause: transport,
        created: true,
        identityCommitted: false,
        reconcile,
      }),
    ).resolves.toBe('resume-blocked');
    expect(reconcile).toHaveBeenCalledWith(undefined);
  });

  it('classifies a create that reconcile found as a partial assignment', async () => {
    const reconcile = vi.fn().mockResolvedValue('found');
    await expect(
      classifySubmitFailure({
        cas,
        cause: transport,
        created: true,
        identityCommitted: false,
        reconcile,
      }),
    ).resolves.toBe('partial-assignment');
    expect(reconcile).toHaveBeenCalledWith('agent-1');
  });

  it('classifies an identity write that never committed as identity-failed', async () => {
    const reconcile = vi.fn().mockResolvedValue('absent');
    await expect(
      classifySubmitFailure({
        cas: null,
        cause: transport,
        created: true,
        identityCommitted: false,
        reconcile,
      }),
    ).resolves.toBe('identity-failed');
  });
});

describe('applyAssignmentPlan', () => {
  const noop = vi.fn();
  const entry = {
    enabled: true,
    id: null,
    mode: 'optional' as const,
    pinnedVersionId: null,
    targetId: 'user-1',
    targetType: 'user' as const,
    versionPolicy: 'latest_published' as const,
  };

  const run = (cas: null, plan: AssignmentPlan) =>
    applyAssignmentPlan({
      authMethod: null,
      cas,
      onCas: noop,
      onRemoved: noop,
      onUpserted: noop,
      plan,
    });

  it.each([
    ['a removal', { removals: ['assignment-1'], upserts: [] }],
    ['an upsert', { removals: [], upserts: [entry] }],
  ])('refuses %s it has no CAS to echo, instead of reading a null one', async (_label, plan) => {
    const cause = await run(null, plan).then(
      () => null,
      (error: unknown) => error,
    );

    // A null read raises a TypeError, which reaches the operator as a crash rather than as the
    // editor's ordinary "the write was rejected" path.
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBeInstanceOf(TypeError);
    expect((cause as Error).message).toBe('PLATFORM_AGENT_ASSIGNMENT_WITHOUT_IDENTITY');
    expect(mocks.removeAssignment).not.toHaveBeenCalled();
    expect(mocks.upsertAssignment).not.toHaveBeenCalled();
  });

  it('leaves an empty plan alone — nothing to write needs no identity', async () => {
    await expect(run(null, { removals: [], upserts: [] })).resolves.toBeNull();
  });
});
