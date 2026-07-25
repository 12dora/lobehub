// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAdminAgentDraft, loadAdminAgentDraft } from './localDraftStorage';
import type { AdminAgentDraft } from './types';
import { useAdminAgentDraftPersistence } from './useAdminAgentDraftPersistence';

const draft = (displayName: string): AdminAgentDraft => ({
  config: {
    avatar: null,
    backgroundColor: null,
    description: null,
    displayName,
    modelParameters: {},
    openingMessage: null,
    openingQuestions: [],
    systemRole: 'x'.repeat(1000),
    tags: [],
  },
  dependencies: { connectors: [], model: null, skills: [] },
  version: '1.0.0',
});

const baseline = (agentId: string) => ({
  agentId,
  draftToken: 'a'.repeat(64),
  revision: 1,
});

describe('useAdminAgentDraftPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid edits into one write of the final draft', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { rerender } = renderHook(
      ({ value }: { value: string }) =>
        useAdminAgentDraftPersistence({
          dirty: true,
          draft: draft(value),
          draftBaseline: baseline('agent-1'),
          editable: true,
        }),
      { initialProps: { value: 'v1' } },
    );

    rerender({ value: 'v2' });
    rerender({ value: 'v3' });
    rerender({ value: 'final' });

    // No write until the trailing debounce fires.
    expect(setItem).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe('final');
  });

  it('flushes the previous agent pending draft on direct id change, then flushes B on unmount', async () => {
    const { rerender, unmount } = renderHook(
      ({ agentId, value }: { agentId: string; value: string }) =>
        useAdminAgentDraftPersistence({
          dirty: true,
          draft: draft(value),
          draftBaseline: baseline(agentId),
          editable: true,
        }),
      { initialProps: { agentId: 'agent-1', value: 'for-a' } },
    );

    // Direct A → B while dirty (not the product path, but a valid prop sequence).
    rerender({ agentId: 'agent-2', value: 'for-b' });
    unmount();

    expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe('for-a');
    expect(loadAdminAgentDraft('agent-2')?.draft.config.displayName).toBe('for-b');
    clearAdminAgentDraft('agent-1');
    clearAdminAgentDraft('agent-2');
  });

  it('flushes agent A on the product route sequence A → null → B before debounce fires', async () => {
    type Props = {
      dirty: boolean;
      draft: AdminAgentDraft | null;
      draftBaseline: ReturnType<typeof baseline> | null;
    };
    const { rerender, unmount } = renderHook(
      ({ dirty, draft: d, draftBaseline }: Props) =>
        useAdminAgentDraftPersistence({
          dirty,
          draft: d,
          draftBaseline,
          editable: true,
        }),
      {
        initialProps: {
          dirty: true,
          draft: draft('for-a'),
          draftBaseline: baseline('agent-1'),
        } as Props,
      },
    );

    // Real product path: detail SWR drops data on id change → editor clears baseline → B hydrates.
    rerender({ dirty: false, draft: null, draftBaseline: null });
    expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe('for-a');

    rerender({ dirty: true, draft: draft('for-b'), draftBaseline: baseline('agent-2') });
    unmount();

    expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe('for-a');
    expect(loadAdminAgentDraft('agent-2')?.draft.config.displayName).toBe('for-b');
    clearAdminAgentDraft('agent-1');
    clearAdminAgentDraft('agent-2');
  });

  it('does not resurrect a just-cleared draft on same-agent save/discard', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) =>
        useAdminAgentDraftPersistence({
          dirty,
          draft: draft('pending-a'),
          draftBaseline: baseline('agent-1'),
          editable: true,
        }),
      { initialProps: { dirty: true } },
    );

    // Pending debounce exists; markSaved/discard keep the same agentId and clear storage.
    clearAdminAgentDraft('agent-1');
    setItem.mockClear();
    rerender({ dirty: false });

    expect(setItem).not.toHaveBeenCalled();
    expect(loadAdminAgentDraft('agent-1')).toBeNull();
  });

  it('clears sticky persist state when the editor goes clean', async () => {
    const { result, rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) =>
        useAdminAgentDraftPersistence({
          dirty,
          draft: draft('x'),
          draftBaseline: baseline('agent-1'),
          editable: true,
        }),
      { initialProps: { dirty: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current).toBe('saved');

    rerender({ dirty: false });
    expect(result.current).toBeNull();
  });

  it('flushes on pagehide', async () => {
    renderHook(() =>
      useAdminAgentDraftPersistence({
        dirty: true,
        draft: draft('pagehide-value'),
        draftBaseline: baseline('agent-1'),
        editable: true,
      }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(loadAdminAgentDraft('agent-1')?.draft.config.displayName).toBe('pagehide-value');
  });
});
