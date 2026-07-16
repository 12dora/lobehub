import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSkillLocalDraft } from '../localDraftStorage';
import type { AdminSkillGetOutput } from '../types';
import { useSkillEditor } from './useSkillEditor';

const mocks = vi.hoisted(() => ({ useBlocker: vi.fn(() => ({ state: 'unblocked' })) }));

vi.mock('react-router', () => ({
  useBlocker: mocks.useBlocker,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: vi.fn(),
}));

const snapshot = (id = 'skill-1', revision = 3): AdminSkillGetOutput => ({
  baseRevision: revision,
  draft: {
    allowBuiltinOverride: false,
    currentVersionId: null,
    description: 'Safe description',
    displayName: `Skill ${id}`,
    distribution: 'default',
    draftSequence: revision,
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

describe('useSkillEditor durable drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('restores a safe per-Skill draft and marks stale revision recovery as conflict', () => {
    saveSkillLocalDraft('skill-1', {
      baseDraft: editable(),
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

  it('keeps unsaved drafts isolated while switching between Skill ids', () => {
    const { rerender, result } = renderHook(({ current }) => useSkillEditor(snapshot(current)), {
      initialProps: { current: 'skill-1' },
    });
    act(() => result.current.updateIdentity('displayName', 'Unsaved first Skill'));
    rerender({ current: 'skill-2' });
    expect(result.current.draft?.identity.displayName).toBe('Skill skill-2');
    rerender({ current: 'skill-1' });
    expect(result.current.draft?.identity.displayName).toBe('Unsaved first Skill');
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
    expect(result.current.draft?.versionDraft?.content).toContain('PRIVATE KEY');
    expect(result.current.persistenceStatus).toBe('sensitive');
    expect(localStorage.getItem('aihub.admin.skills.draft.skill-1')).toBeNull();
  });

  it('ignores recovery drafts and mutations for read-only auditors', () => {
    saveSkillLocalDraft('skill-1', {
      baseDraft: editable(),
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
