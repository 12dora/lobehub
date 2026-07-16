/**
 * Pure three-way revision-conflict state machine for the admin settings editor.
 *
 * A conflict keeps three independent snapshots:
 * - originalBaseDraft: the server draft the user started editing;
 * - localDraft: the user's durable work;
 * - serverDraft: the newest server draft fetched after the revision conflict.
 */

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

export type DraftMap = AdminSettingsGetDraftOutput['draft'];

export type ConflictPhase =
  'idle' | 'awaitingServer' | 'latestUnavailable' | 'conflict' | 'rebased' | 'discarded';

export interface ConflictState {
  conflictingPaths: string[];
  localBaseRevision: number;
  localDraft: DraftMap;
  localDraftToken: string;
  originalBaseDraft: DraftMap;
  phase: ConflictPhase;
  serverBaseRevision: number;
  serverDraft: DraftMap;
  serverDraftToken: string | null;
}

export type ConflictEvent =
  | {
      localBaseRevision: number;
      localDraft: DraftMap;
      localDraftToken: string;
      originalBaseDraft: DraftMap;
      type: 'CONFLICT_DETECTED';
    }
  | { type: 'REFRESH_SERVER_STARTED' }
  | { type: 'REFRESH_SERVER_FAILED' }
  | {
      serverBaseRevision: number;
      serverDraft: DraftMap;
      serverDraftToken: string;
      type: 'REFRESH_SERVER_SUCCEEDED';
    }
  | { type: 'REBASE' }
  | { type: 'DISCARD' }
  | { type: 'CLEAR' };

const areEqual = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const allPaths = (...drafts: DraftMap[]) =>
  [...new Set(drafts.flatMap((draft) => Object.keys(draft)))].sort();

export const getChangedPaths = (base: DraftMap, candidate: DraftMap): string[] =>
  allPaths(base, candidate).filter((path) => !areEqual(base[path], candidate[path]));

export const getConflictingPaths = (params: {
  localDraft: DraftMap;
  originalBaseDraft: DraftMap;
  serverDraft: DraftMap;
}): string[] => {
  const localChanged = new Set(getChangedPaths(params.originalBaseDraft, params.localDraft));
  const serverChanged = new Set(getChangedPaths(params.originalBaseDraft, params.serverDraft));

  return allPaths(params.localDraft, params.serverDraft).filter(
    (path) =>
      localChanged.has(path) &&
      serverChanged.has(path) &&
      !areEqual(params.localDraft[path], params.serverDraft[path]),
  );
};

/**
 * Apply only the user's actual changes on top of the latest server draft.
 * Local deletion is preserved as a deletion; unchanged old-base values never
 * overwrite a newer server value.
 */
export const rebaseDraft = (params: {
  localDraft: DraftMap;
  originalBaseDraft: DraftMap;
  serverDraft: DraftMap;
}): DraftMap => {
  const merged = { ...params.serverDraft };
  for (const path of getChangedPaths(params.originalBaseDraft, params.localDraft)) {
    const localPolicy = params.localDraft[path];
    if (localPolicy) merged[path] = localPolicy;
    else delete merged[path];
  }
  return merged;
};

export const initialConflictState = (): ConflictState => ({
  conflictingPaths: [],
  localBaseRevision: 0,
  localDraft: {},
  localDraftToken: '',
  originalBaseDraft: {},
  phase: 'idle',
  serverBaseRevision: 0,
  serverDraft: {},
  serverDraftToken: null,
});

export const reduceConflict = (state: ConflictState, event: ConflictEvent): ConflictState => {
  switch (event.type) {
    case 'CONFLICT_DETECTED': {
      return {
        conflictingPaths: [],
        localBaseRevision: event.localBaseRevision,
        localDraft: event.localDraft,
        localDraftToken: event.localDraftToken,
        originalBaseDraft: event.originalBaseDraft,
        phase: 'awaitingServer',
        serverBaseRevision: 0,
        serverDraft: {},
        serverDraftToken: null,
      };
    }
    case 'REFRESH_SERVER_STARTED': {
      if (
        state.phase !== 'awaitingServer' &&
        state.phase !== 'latestUnavailable' &&
        state.phase !== 'conflict'
      ) {
        return state;
      }
      return { ...state, phase: 'awaitingServer' };
    }
    case 'REFRESH_SERVER_FAILED': {
      if (state.phase !== 'awaitingServer') return state;
      return { ...state, phase: 'latestUnavailable' };
    }
    case 'REFRESH_SERVER_SUCCEEDED': {
      if (state.phase !== 'awaitingServer' && state.phase !== 'latestUnavailable') return state;
      return {
        ...state,
        conflictingPaths: getConflictingPaths({
          localDraft: state.localDraft,
          originalBaseDraft: state.originalBaseDraft,
          serverDraft: event.serverDraft,
        }),
        serverBaseRevision: event.serverBaseRevision,
        serverDraft: event.serverDraft,
        serverDraftToken: event.serverDraftToken,
        phase: 'conflict',
      };
    }
    case 'REBASE': {
      if (state.phase !== 'conflict' || !state.serverDraftToken) return state;
      return {
        ...state,
        localBaseRevision: state.serverBaseRevision,
        localDraft: rebaseDraft(state),
        localDraftToken: state.serverDraftToken,
        phase: 'rebased',
      };
    }
    case 'DISCARD': {
      if (state.phase !== 'conflict' || !state.serverDraftToken) return state;
      return {
        conflictingPaths: [],
        localBaseRevision: state.serverBaseRevision,
        localDraft: { ...state.serverDraft },
        localDraftToken: state.serverDraftToken,
        originalBaseDraft: { ...state.serverDraft },
        phase: 'discarded',
        serverBaseRevision: state.serverBaseRevision,
        serverDraft: state.serverDraft,
        serverDraftToken: state.serverDraftToken,
      };
    }
    case 'CLEAR': {
      return initialConflictState();
    }
  }
};

/** Never mutate while the editor is based on a stale or unresolved revision. */
export const canMutateAgainstBase = (
  state: ConflictState,
  expectedRevision: number,
  expectedDraftToken: string,
): boolean => {
  if (
    state.phase === 'awaitingServer' ||
    state.phase === 'latestUnavailable' ||
    state.phase === 'conflict'
  ) {
    return false;
  }
  if (state.phase === 'rebased' || state.phase === 'discarded') {
    return (
      expectedRevision === state.serverBaseRevision && expectedDraftToken === state.serverDraftToken
    );
  }
  return true;
};
