// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  canMutateAgainstBase,
  getConflictingPaths,
  initialConflictState,
  rebaseDraft,
  reduceConflict,
} from './conflictStateMachine';

const policy = (value: number, mode: 'default' | 'locked' = 'default') => ({
  mode,
  schemaVersion: 1,
  value,
  visibility: 'visible' as const,
});

const original = {
  'general.fontSize': policy(16),
  'memory.enabled': policy(1),
};
const local = {
  ...original,
  'general.fontSize': policy(18),
};
const server = {
  ...original,
  'general.fontSize': policy(20, 'locked'),
  'memory.enabled': policy(2),
};

const detect = () =>
  reduceConflict(initialConflictState(), {
    localBaseRevision: 1,
    localDraft: local,
    originalBaseDraft: original,
    serverBaseRevision: 2,
    serverDraft: server,
    type: 'CONFLICT_DETECTED',
  });

describe('conflictStateMachine', () => {
  it('finds only paths changed differently by both sides', () => {
    expect(
      getConflictingPaths({ localDraft: local, originalBaseDraft: original, serverDraft: server }),
    ).toEqual(['general.fontSize']);
  });

  it('blocks mutation while a conflict is unresolved', () => {
    const state = detect();
    expect(state.phase).toBe('conflict');
    expect(canMutateAgainstBase(state, 1)).toBe(false);
    expect(canMutateAgainstBase(state, 2)).toBe(false);
  });

  it('rebases local changes onto the latest server base without overwriting server-only changes', () => {
    const merged = rebaseDraft({
      localDraft: local,
      originalBaseDraft: original,
      serverDraft: server,
    });
    expect(merged['general.fontSize']?.value).toBe(18);
    expect(merged['memory.enabled']?.value).toBe(2);

    const state = reduceConflict(detect(), { type: 'REBASE' });
    expect(state.phase).toBe('rebased');
    expect(state.localBaseRevision).toBe(2);
    expect(state.conflictingPaths).toEqual(['general.fontSize']);
    expect(canMutateAgainstBase(state, 1)).toBe(false);
    expect(canMutateAgainstBase(state, 2)).toBe(true);
  });

  it('refreshes the server snapshot repeatedly without replacing local work', () => {
    const latest = { ...server, 'memory.enabled': policy(3) };
    const once = reduceConflict(detect(), {
      serverBaseRevision: 3,
      serverDraft: latest,
      type: 'REFRESH_SERVER',
    });
    const twice = reduceConflict(once, {
      serverBaseRevision: 4,
      serverDraft: { ...latest, 'memory.enabled': policy(4) },
      type: 'REFRESH_SERVER',
    });
    expect(twice.serverBaseRevision).toBe(4);
    expect(twice.localDraft['general.fontSize']?.value).toBe(18);
    expect(twice.conflictingPaths).toEqual(['general.fontSize']);
  });

  it('discard adopts the latest server draft and current revision', () => {
    const state = reduceConflict(detect(), { type: 'DISCARD' });
    expect(state.phase).toBe('discarded');
    expect(state.localDraft).toEqual(server);
    expect(state.localBaseRevision).toBe(2);
    expect(canMutateAgainstBase(state, 2)).toBe(true);
  });
});
