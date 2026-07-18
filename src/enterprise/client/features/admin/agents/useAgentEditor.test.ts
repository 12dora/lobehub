// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAdminAgentDraft } from './localDraftStorage';
import type { AdminAgentDetailOutput } from './types';
import { useAgentEditor } from './useAgentEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router', () => ({ useBlocker: () => ({ state: 'unblocked' }) }));
vi.mock('@lobehub/ui/base-ui', () => ({ confirmModal: vi.fn() }));

const model = {
  modelKey: 'model',
  providerChecksum: 'a'.repeat(64),
  providerKey: 'provider',
  providerRevision: 1,
};

const createSnapshot = (
  revision: number,
  tokenCharacter: string,
  displayName: string,
): AdminAgentDetailOutput => ({
  assignments: [],
  draftToken: tokenCharacter.repeat(64),
  identity: {
    agentKey: 'research',
    currentVersionId: `version-${revision}`,
    draftSequence: revision,
    id: 'agent-1',
    isDefault: false,
    migrationRequired: false,
    revision,
    status: 'published',
    systemKey: null,
  },
  rollouts: [],
  versions: [
    {
      agentId: 'agent-1',
      checksum: 'c'.repeat(64),
      config: {
        avatar: null,
        backgroundColor: null,
        description: null,
        displayName,
        modelParameters: {},
        openingMessage: null,
        openingQuestions: [],
        systemRole: 'Research carefully.',
        tags: [],
      },
      createdAt: new Date('2026-07-17T00:00:00Z'),
      createdBy: 'admin-1',
      dependencySnapshot: { connectors: [], model, skills: [] },
      id: `version-${revision}`,
      version: `1.0.${revision}`,
    },
  ],
});

describe('useAgentEditor frozen recovery baseline', () => {
  beforeEach(() => localStorage.clear());

  it('keeps dirty input and its origin CAS across repeated same-Agent refreshes', async () => {
    const initial = createSnapshot(3, 'b', 'Server original');
    const { result, rerender, unmount } = renderHook(
      ({ snapshot }: { snapshot: AdminAgentDetailOutput }) => useAgentEditor(snapshot, true),
      { initialProps: { snapshot: initial } },
    );
    await waitFor(() => expect(result.current.draft?.config.displayName).toBe('Server original'));

    act(() => {
      result.current.updateDraft((current) => ({
        ...current,
        config: { ...current.config, displayName: 'Local unfinished value' },
      }));
    });
    await waitFor(() =>
      expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe(
        'Local unfinished value',
      ),
    );

    const advanced = createSnapshot(4, 'd', 'Server advanced');
    rerender({ snapshot: advanced });
    await waitFor(() => expect(result.current.conflict).toBe(true));

    expect(result.current.draft?.config.displayName).toBe('Local unfinished value');
    expect(result.current.draftBaseline).toEqual({
      agentId: 'agent-1',
      draftToken: 'b'.repeat(64),
      revision: 3,
    });
    expect(loadAdminAgentDraft('agent-1')).toMatchObject({
      draft: { config: { displayName: 'Local unfinished value' } },
      draftToken: 'b'.repeat(64),
      revision: 3,
    });

    rerender({ snapshot: createSnapshot(5, 'e', 'Server advanced again') });
    await waitFor(() => expect(result.current.conflict).toBe(true));
    expect(result.current.draft?.config.displayName).toBe('Local unfinished value');
    expect(result.current.draftBaseline?.revision).toBe(3);
    expect(loadAdminAgentDraft('agent-1')?.revision).toBe(3);

    // A real page refresh remounts the hook. The recovery envelope must still expose the old CAS
    // as a conflict instead of silently rebasing the stored draft to the latest snapshot.
    unmount();
    const refreshed = renderHook(() =>
      useAgentEditor(createSnapshot(5, 'e', 'Server advanced again'), true),
    );
    await waitFor(() => expect(refreshed.result.current.conflict).toBe(true));
    expect(refreshed.result.current.draft?.config.displayName).toBe('Local unfinished value');
    expect(refreshed.result.current.draftBaseline).toEqual({
      agentId: 'agent-1',
      draftToken: 'b'.repeat(64),
      revision: 3,
    });
  });

  it('adopts the newest authoritative snapshot only after explicit discard', async () => {
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: AdminAgentDetailOutput }) => useAgentEditor(snapshot, true),
      { initialProps: { snapshot: createSnapshot(3, 'b', 'Server original') } },
    );
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => {
      result.current.updateDraft((current) => ({
        ...current,
        config: { ...current.config, displayName: '' },
      }));
    });
    await waitFor(() => expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe(''));

    rerender({ snapshot: createSnapshot(6, 'f', 'Newest server value') });
    await waitFor(() => expect(result.current.conflict).toBe(true));
    expect(result.current.draft?.config.displayName).toBe('');

    act(() => result.current.discard());

    expect(result.current.draft?.config.displayName).toBe('Newest server value');
    expect(result.current.draftBaseline).toEqual({
      agentId: 'agent-1',
      draftToken: 'f'.repeat(64),
      revision: 6,
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.conflict).toBe(false);
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });
});
