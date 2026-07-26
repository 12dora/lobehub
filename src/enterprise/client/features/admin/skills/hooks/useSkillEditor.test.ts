import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadSkillLocalDraft, saveSkillLocalDraft } from '../localDraftStorage';
import type { AdminSkillGetOutput } from '../types';
import { useSkillEditor } from './useSkillEditor';

interface ConfirmOptions {
  onCancel: () => void;
  onOk: () => void;
}

type BlockerPredicate = (args: {
  currentLocation: { pathname: string };
  nextLocation: { pathname: string };
}) => boolean;

const mocks = vi.hoisted(() => ({
  confirmModal: vi.fn((_options: ConfirmOptions) => ({ close: vi.fn(), destroy: vi.fn() })),
  createModal: vi.fn((_options: any) => ({ close: vi.fn(), destroy: vi.fn() })),
  useBlocker: vi.fn((_condition?: boolean | BlockerPredicate): any => ({ state: 'unblocked' })),
}));

vi.mock('react-router', () => ({
  useBlocker: mocks.useBlocker,
}));

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmModal: mocks.confirmModal,
  createModal: mocks.createModal,
}));

const snapshot = (
  id = 'skill-1',
  revision = 3,
  draftSequence = revision,
  displayName = `Skill ${id}`,
): AdminSkillGetOutput => ({
  baseRevision: revision,
  draft: {
    allowBuiltinOverride: false,
    currentVersionId: null,
    description: 'Safe description',
    displayName,
    distribution: 'default',
    draftSequence,
    enabled: true,
    id,
    revision,
    skillKey: id,
    source: 'uploaded',
    status: 'draft',
  },
  draftToken: 'a'.repeat(64),
  latestVersion: null,
  publishedVersion: null,
});

const editable = (id = 'skill-1') => ({
  identity: {
    description: 'Safe description',
    displayName: `Skill ${id}`,
    distribution: 'default' as const,
    enabled: true,
  },
  versionDraft: null,
});

const versionDraft = () => ({
  content: '# Safe Skill',
  contentRef: '',
  manifestText: JSON.stringify({
    description: 'Safe Skill',
    displayName: 'Safe Skill',
    localizedDescriptions: {},
    localizedDisplayNames: {},
    permissions: {
      filesystem: 'none',
      network: { allowedHosts: [], enabled: false },
      tools: { allow: [] },
    },
    skillDependencies: [],
    toolDependencies: [],
  }),
  resourcesText: '[]',
  version: '1.0.0',
});

const flushPersistence = () => {
  act(() => {
    vi.advanceTimersByTime(400);
  });
};

describe('useSkillEditor durable drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('restores a safe per-Skill draft and marks stale revision recovery as conflict', () => {
    saveSkillLocalDraft('skill-1', {
      baseDraft: editable(),
      baseDraftSequence: 2,
      baseRevision: 2,
      draft: {
        ...editable(),
        identity: { ...editable().identity, displayName: 'Recovered local name' },
      },
      savedAt: new Date(0).toISOString(),
    });

    const { result } = renderHook(() => useSkillEditor(snapshot()));
    expect(result.current.draft?.identity.displayName).toBe('Recovered local name');
    expect(result.current.dirty).toBe(true);
    expect(result.current.conflict).toBe(true);
  });

  it.each([
    ['draft sequence', snapshot('skill-1', 3, 4), editable()],
    ['safe base fingerprint', snapshot('skill-1', 3, 3, 'Server changed the name'), editable()],
  ])('marks recovery conflict when the same revision has a changed %s', (_case, next, base) => {
    saveSkillLocalDraft('skill-1', {
      baseDraft: base,
      baseDraftSequence: 3,
      baseRevision: 3,
      draft: {
        ...editable(),
        identity: { ...editable().identity, description: 'Local change' },
      },
      savedAt: new Date(0).toISOString(),
    });

    const { result } = renderHook(() => useSkillEditor(next));
    expect(result.current.conflict).toBe(true);
    expect(result.current.dirty).toBe(true);
    expect(loadSkillLocalDraft('skill-1')?.baseDraftSequence).toBe(3);
    expect(loadSkillLocalDraft('skill-1')?.baseDraft).toEqual(base);
  });

  it('keeps unsaved drafts isolated while switching between Skill ids', () => {
    const { rerender, result } = renderHook(({ current }) => useSkillEditor(snapshot(current)), {
      initialProps: { current: 'skill-1' },
    });
    act(() => result.current.updateIdentity('displayName', 'Unsaved first Skill'));
    flushPersistence();
    rerender({ current: 'skill-2' });
    expect(result.current.draft?.identity.displayName).toBe('Skill skill-2');
    rerender({ current: 'skill-1' });
    expect(result.current.draft?.identity.displayName).toBe('Unsaved first Skill');
  });

  it('coalesces rapid draft edits into one trailing recovery write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useSkillEditor(snapshot()));

    act(() => {
      result.current.updateIdentity('displayName', 'First');
      result.current.updateIdentity('displayName', 'Second');
      result.current.updateIdentity('displayName', 'Final');
    });

    expect(setItem).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(setItem).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(loadSkillLocalDraft('skill-1')?.draft.identity.displayName).toBe('Final');
  });

  it('resets persistence state through the real discard callback', () => {
    const { result } = renderHook(() => useSkillEditor(snapshot()));
    act(() => result.current.updateIdentity('displayName', 'Discard me'));
    flushPersistence();
    expect(loadSkillLocalDraft('skill-1')).not.toBeNull();

    act(() => result.current.discardLocal());

    expect(result.current.dirty).toBe(false);
    expect(result.current.saveState).toBe('idle');
    expect(result.current.persistenceStatus).toBe('saved');
    expect(result.current.draft?.identity.displayName).toBe('Skill skill-1');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
  });

  it('clears recovery state through the real successful identity commit callback', () => {
    const { result } = renderHook(() => useSkillEditor(snapshot()));
    act(() => result.current.updateIdentity('displayName', 'Committed name'));
    flushPersistence();
    expect(loadSkillLocalDraft('skill-1')).not.toBeNull();

    act(() => result.current.markSaved());

    expect(result.current.dirty).toBe(false);
    expect(result.current.saveState).toBe('saved');
    expect(result.current.persistenceStatus).toBe('saved');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
  });

  it('clears the version draft through the real successful version commit callback', () => {
    const { result } = renderHook(() => useSkillEditor(snapshot()));
    act(() => result.current.updateVersionDraft(versionDraft()));
    flushPersistence();
    expect(loadSkillLocalDraft('skill-1')?.draft.versionDraft).not.toBeNull();

    act(() => result.current.markVersionSaved());

    expect(result.current.draft?.versionDraft).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(result.current.saveState).toBe('saved');
    expect(result.current.persistenceStatus).toBe('saved');
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
  });

  it('flushes a pending recovery write before an accepted Skill identity change', () => {
    const { rerender, result } = renderHook(({ current }) => useSkillEditor(snapshot(current)), {
      initialProps: { current: 'skill-1' },
    });
    act(() => result.current.updateIdentity('displayName', 'Pending first Skill'));

    rerender({ current: 'skill-2' });
    expect(loadSkillLocalDraft('skill-1')).toBeNull();
    expect(mocks.confirmModal).toHaveBeenCalledTimes(1);
    act(() => mocks.confirmModal.mock.calls[0][0].onOk());

    expect(result.current.activeSkillId).toBe('skill-2');
    expect(loadSkillLocalDraft('skill-1')?.draft.identity.displayName).toBe('Pending first Skill');
  });

  it('flushes a pending recovery write on pagehide before the debounce elapses', () => {
    const { result } = renderHook(() => useSkillEditor(snapshot()));
    act(() => result.current.updateIdentity('displayName', 'Pending page hide'));

    expect(loadSkillLocalDraft('skill-1')).toBeNull();
    act(() => window.dispatchEvent(new Event('pagehide')));

    expect(loadSkillLocalDraft('skill-1')?.draft.identity.displayName).toBe('Pending page hide');
  });

  it('flushes a pending recovery write on unmount before the debounce elapses', () => {
    const { result, unmount } = renderHook(() => useSkillEditor(snapshot()));
    act(() => result.current.updateIdentity('displayName', 'Pending unmount'));

    expect(loadSkillLocalDraft('skill-1')).toBeNull();
    unmount();

    expect(loadSkillLocalDraft('skill-1')?.draft.identity.displayName).toBe('Pending unmount');
  });

  it('keeps suspicious content in memory only and reports the persistence boundary', () => {
    const { result } = renderHook(() => useSkillEditor(snapshot()));
    act(() =>
      result.current.updateVersionDraft({
        content: '-----BEGIN PRIVATE KEY----- fake material',
        contentRef: '',
        manifestText: JSON.stringify({
          description: 'Safe Skill',
          displayName: 'Safe Skill',
          localizedDescriptions: {},
          localizedDisplayNames: {},
          permissions: {
            filesystem: 'none',
            network: { allowedHosts: [], enabled: false },
            tools: { allow: [] },
          },
          skillDependencies: [],
          toolDependencies: [],
        }),
        resourcesText: '[]',
        version: '1.0.0',
      }),
    );
    flushPersistence();
    expect(result.current.draft?.versionDraft?.content).toContain('PRIVATE KEY');
    expect(result.current.persistenceStatus).toBe('sensitive');
    expect(localStorage.getItem('aihub.admin.skills.draft.skill-1')).toBeNull();
  });

  it('blocks same-page Skill hydration when an unsafe dirty draft has no durable copy', () => {
    const { rerender, result } = renderHook(({ current }) => useSkillEditor(snapshot(current)), {
      initialProps: { current: 'skill-1' },
    });
    act(() =>
      result.current.updateVersionDraft({
        content: '-----BEGIN PRIVATE KEY----- fake material',
        contentRef: '',
        manifestText: JSON.stringify({
          description: 'Safe Skill',
          displayName: 'Safe Skill',
          localizedDescriptions: {},
          localizedDisplayNames: {},
          permissions: {
            filesystem: 'none',
            network: { allowedHosts: [], enabled: false },
            tools: { allow: [] },
          },
          skillDependencies: [],
          toolDependencies: [],
        }),
        resourcesText: '[]',
        version: '1.0.0',
      }),
    );
    flushPersistence();
    expect(result.current.persistenceStatus).toBe('sensitive');

    rerender({ current: 'skill-2' });
    expect(result.current.activeSkillId).toBe('skill-1');
    expect(result.current.pendingSwitchId).toBe('skill-2');
    expect(result.current.draft?.versionDraft?.content).toContain('PRIVATE KEY');
    expect(mocks.confirmModal).toHaveBeenCalledTimes(1);

    const options = mocks.confirmModal.mock.calls[0][0];
    act(() => options.onCancel());
    expect(result.current.activeSkillId).toBe('skill-1');
    expect(result.current.pendingSwitchId).toBeNull();
    expect(result.current.draft?.versionDraft?.content).toContain('PRIVATE KEY');

    rerender({ current: 'skill-1' });
    expect(result.current.activeSkillId).toBe('skill-1');
    expect(result.current.draft?.versionDraft?.content).toContain('PRIVATE KEY');

    rerender({ current: 'skill-2' });
    expect(result.current.pendingSwitchId).toBe('skill-2');
    expect(mocks.confirmModal).toHaveBeenCalledTimes(2);
    const discardOptions = mocks.confirmModal.mock.calls[1][0];
    act(() => discardOptions.onOk());
    expect(result.current.activeSkillId).toBe('skill-2');
    expect(result.current.pendingSwitchId).toBeNull();
    expect(result.current.draft?.versionDraft).toBeNull();
  });

  it('binds Leave allowance to the target Skill without consuming it on an active-Skill refresh', () => {
    const proceed = vi.fn();
    const reset = vi.fn();
    const { rerender, result } = renderHook(({ current }) => useSkillEditor(current), {
      initialProps: { current: snapshot('skill-1') },
    });
    act(() =>
      result.current.updateVersionDraft({
        content: '-----BEGIN PRIVATE KEY----- fake material',
        contentRef: '',
        manifestText: JSON.stringify({
          description: 'Safe Skill',
          displayName: 'Safe Skill',
          localizedDescriptions: {},
          localizedDisplayNames: {},
          permissions: {
            filesystem: 'none',
            network: { allowedHosts: [], enabled: false },
            tools: { allow: [] },
          },
          skillDependencies: [],
          toolDependencies: [],
        }),
        resourcesText: '[]',
        version: '1.0.0',
      }),
    );
    flushPersistence();

    const shouldBlock = mocks.useBlocker.mock.calls.at(-1)?.[0];
    if (typeof shouldBlock !== 'function') throw new TypeError('expected a blocker predicate');
    expect(
      shouldBlock({
        currentLocation: { pathname: '/admin/skills/skill-1' },
        nextLocation: { pathname: '/admin/skills/skill-1' },
      }),
    ).toBe(false);
    expect(
      shouldBlock({
        currentLocation: { pathname: '/admin/skills/skill-1' },
        nextLocation: { pathname: '/admin/skills/skill-2' },
      }),
    ).toBe(true);

    mocks.useBlocker.mockReturnValue({ proceed, reset, state: 'blocked' });
    rerender({ current: snapshot('skill-1') });
    expect(mocks.createModal).toHaveBeenCalledTimes(1);
    const leaveModalContent = mocks.createModal.mock.calls[0][0].content as any;
    const footer = leaveModalContent.props.children[1];
    const proceedButton = footer.props.children[1];
    act(() => proceedButton.props.onClick());
    expect(proceed).toHaveBeenCalledTimes(1);

    mocks.useBlocker.mockReturnValue({ state: 'unblocked' });
    rerender({
      current: {
        ...snapshot('skill-1', 4, 4),
        draftToken: 'b'.repeat(64),
      },
    });
    expect(result.current.activeSkillId).toBe('skill-1');
    expect(result.current.draft?.versionDraft?.content).toContain('PRIVATE KEY');
    expect(mocks.confirmModal).toHaveBeenCalledTimes(1);

    rerender({ current: snapshot('skill-2') });
    expect(result.current.activeSkillId).toBe('skill-2');
    expect(result.current.draft?.versionDraft).toBeNull();
    expect(mocks.confirmModal).toHaveBeenCalledTimes(1);
  });

  it('ignores recovery drafts and mutations for read-only auditors', () => {
    saveSkillLocalDraft('skill-1', {
      baseDraft: editable(),
      baseDraftSequence: 3,
      baseRevision: 3,
      draft: {
        ...editable(),
        identity: { ...editable().identity, displayName: 'Recovered local name' },
      },
      savedAt: new Date(0).toISOString(),
    });
    const { result } = renderHook(() => useSkillEditor(snapshot(), false));
    expect(result.current.draft?.identity.displayName).toBe('Skill skill-1');
    expect(result.current.dirty).toBe(false);
    expect(mocks.useBlocker).toHaveBeenLastCalledWith(false);
    act(() => result.current.updateIdentity('displayName', 'Cannot write'));
    expect(result.current.draft?.identity.displayName).toBe('Skill skill-1');
  });
});
