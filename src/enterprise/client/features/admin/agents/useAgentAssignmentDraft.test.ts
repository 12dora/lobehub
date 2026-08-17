// @vitest-environment happy-dom
import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Assignment } from './assignmentDraft';
import { useAgentAssignmentDraft } from './useAgentAssignmentDraft';

const assignment = (over: Partial<Assignment> = {}): Assignment =>
  ({
    agentId: 'agent-1',
    enabled: true,
    id: 'assignment-1',
    mode: 'optional',
    pinnedVersionId: null,
    targetId: 'user-1',
    targetType: 'user',
    versionPolicy: 'latest_published',
    ...over,
  }) as Assignment;

describe('useAgentAssignmentDraft', () => {
  it('starts clean from loaded assignments that already follow the published pointer', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([assignment()]));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.dirty).toBe(false);
    expect(result.current.plan).toEqual({ removals: [], upserts: [] });
  });

  it('schedules an un-pin for a LEGACY pinned row instead of leaving it silently pinned', () => {
    // Version policy left the UI, so a row created before that still points at a fixed version.
    // The baseline keeps that raw policy, so it reads as a pending change the next save resolves.
    const { result } = renderHook(() =>
      useAgentAssignmentDraft([
        assignment({ pinnedVersionId: 'version-3', versionPolicy: 'pinned' }),
      ]),
    );
    expect(result.current.dirty).toBe(true);
    expect(result.current.plan.removals).toEqual([]);
    expect(result.current.plan.upserts).toEqual([
      expect.objectContaining({
        id: 'assignment-1',
        pinnedVersionId: null,
        versionPolicy: 'latest_published',
      }),
    ]);
    // The row itself looks entirely ordinary — no version vocabulary leaks back into the UI.
    expect(result.current.entries[0]).toMatchObject({ mode: 'optional', targetId: 'user-1' });
  });

  it('goes quiet once the un-pin commits', () => {
    const { result } = renderHook(() =>
      useAgentAssignmentDraft([
        assignment({ pinnedVersionId: 'version-3', versionPolicy: 'pinned' }),
      ]),
    );
    act(() => result.current.markUpserted(assignment()));
    expect(result.current.dirty).toBe(false);
  });

  it('refuses to edit a truncated list rather than writing a partial diff', () => {
    const { result } = renderHook(() =>
      useAgentAssignmentDraft([assignment()], { truncated: true }),
    );
    expect(result.current.truncated).toBe(true);
    // The rows are still readable…
    expect(result.current.entries).toHaveLength(1);

    act(() => result.current.remove(result.current.entries[0]!));
    act(() => result.current.patchDraft('targetType', 'user'));
    act(() => result.current.patchDraft('targetId', 'user-9'));
    act(() => result.current.add());

    // …but nothing can be scheduled, so Save can never write half a diff.
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.plan).toEqual({ removals: [], upserts: [] });
    expect(result.current.dirty).toBe(false);
  });

  it('re-bases on the server after an ambiguous failure, adopting ids for targets that landed', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([]));
    act(() => result.current.patchDraft('targetType', 'user'));
    act(() => result.current.patchDraft('targetId', 'user-7'));
    act(() => result.current.add());
    expect(result.current.plan.upserts[0]!.id).toBeNull();

    // The write DID commit; only its response was lost. A blind retry would create a duplicate.
    act(() => result.current.reconcile([assignment({ id: 'assignment-7', targetId: 'user-7' })]));
    expect(result.current.entries[0]!.id).toBe('assignment-7');
    expect(result.current.dirty).toBe(false);
  });

  it('refuses to add a target the operator has not identified yet', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([]));
    act(() => result.current.patchDraft('targetType', 'user'));
    act(() => result.current.add());
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.error).toBe('agentCatalog.assignment.errors.targetRequired');
  });

  it('adds a global target on the sentinel id and never pins a version', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([]));
    act(() => result.current.patchDraft('mode', 'mandatory'));
    act(() => result.current.add());
    expect(result.current.entries).toEqual([
      {
        enabled: true,
        id: null,
        mode: 'mandatory',
        pinnedVersionId: null,
        targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
        targetType: 'global',
        versionPolicy: 'latest_published',
      },
    ]);
    // The add form resets, so the same row cannot be added twice by a second click.
    expect(result.current.draft).toEqual({
      enabled: true,
      mode: 'optional',
      targetId: '',
      targetType: 'global',
    });
    expect(result.current.plan.upserts).toHaveLength(1);
  });

  it('clears the typed identifier when the target type changes under it', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([]));
    act(() => result.current.patchDraft('targetType', 'user'));
    act(() => result.current.patchDraft('targetId', 'user-9'));
    act(() => result.current.patchDraft('targetType', 'global_role'));
    expect(result.current.draft.targetId).toBe('');
  });

  it('updates an existing target in place instead of creating a duplicate row', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([assignment()]));
    act(() => result.current.patchDraft('targetType', 'user'));
    act(() => result.current.patchDraft('targetId', 'user-1'));
    act(() => result.current.patchDraft('mode', 'mandatory'));
    act(() => result.current.add());

    expect(result.current.entries).toHaveLength(1);
    // The server id survives, so the write is an update of the same row (the unique index agrees).
    expect(result.current.entries[0]).toMatchObject({ id: 'assignment-1', mode: 'mandatory' });
    expect(result.current.plan).toEqual({
      removals: [],
      upserts: [expect.objectContaining({ id: 'assignment-1' })],
    });
  });

  it('plans a removal for a row the operator dropped', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([assignment()]));
    act(() => result.current.remove(result.current.entries[0]!));
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.plan.removals).toEqual(['assignment-1']);
    expect(result.current.dirty).toBe(true);
  });

  it('retires a committed removal from the baseline so a retry never replays it', () => {
    const { result } = renderHook(() =>
      useAgentAssignmentDraft([assignment(), assignment({ id: 'assignment-2', targetId: 'u2' })]),
    );
    act(() => result.current.remove(result.current.entries[0]!));
    act(() => result.current.remove(result.current.entries[0]!));
    expect(result.current.plan.removals).toEqual(['assignment-1', 'assignment-2']);

    act(() => result.current.markRemoved('assignment-1'));
    expect(result.current.plan.removals).toEqual(['assignment-2']);
  });

  it('adopts the server id of a committed upsert in both the baseline and the list', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft([]));
    act(() => result.current.patchDraft('targetType', 'user'));
    act(() => result.current.patchDraft('targetId', 'user-7'));
    act(() => result.current.add());
    expect(result.current.plan.upserts[0]!.id).toBeNull();

    act(() => result.current.markUpserted(assignment({ id: 'assignment-7', targetId: 'user-7' })));
    expect(result.current.entries[0]!.id).toBe('assignment-7');
    // Nothing left to write — the modal must not send the same create twice on a retry.
    expect(result.current.dirty).toBe(false);
  });

  it('holds nothing at all when the caller has no assign grant', () => {
    const { result } = renderHook(() => useAgentAssignmentDraft(undefined));
    expect(result.current.entries).toEqual([]);
    expect(result.current.dirty).toBe(false);
  });
});
