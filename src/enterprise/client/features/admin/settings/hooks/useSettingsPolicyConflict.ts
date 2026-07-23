'use client';

import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from 'react';
import type { KeyedMutator } from 'swr';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { type ConflictEvent, type ConflictState, reduceConflict } from '../conflictStateMachine';
import { clearLocalDraft, saveLocalDraft } from '../localDraftStorage';
import type { DraftMap, SaveState } from '../settingsPolicyController';
import { clearConflictDraft, saveConflictDraft } from '../settingsPolicyController';

type DraftSnapshot = AdminSettingsGetDraftOutput;

export const useSettingsPolicyConflict = (params: {
  activeBaseRevision: number;
  activeDraftToken: string;
  conflictState: ConflictState;
  data: DraftSnapshot | undefined;
  dispatchConflict: Dispatch<ConflictEvent>;
  draft: DraftMap;
  mutate: KeyedMutator<DraftSnapshot>;
  originalBaseDraftRef: MutableRefObject<DraftMap>;
  resetValidation: () => void;
  setActiveBaseRevision: (revision: number) => void;
  setActiveDraftToken: (token: string) => void;
  setDirty: (dirty: boolean) => void;
  setDraft: Dispatch<SetStateAction<DraftMap>>;
  setImpact: Dispatch<
    SetStateAction<{ pathsWithOverrides: number; totalOverrideRows: number } | null>
  >;
  setSaveError: (error: string | null) => void;
  setSaveState: (state: SaveState) => void;
  setValidationMsg: (msg: string | null) => void;
}) => {
  const {
    activeBaseRevision,
    activeDraftToken,
    conflictState,
    data,
    dispatchConflict,
    draft,
    mutate,
    originalBaseDraftRef,
    resetValidation,
    setActiveBaseRevision,
    setActiveDraftToken,
    setDirty,
    setDraft,
    setImpact,
    setSaveError,
    setSaveState,
    setValidationMsg,
  } = params;

  const enterRevisionConflict = useCallback(async () => {
    if (!data) return;
    saveConflictDraft({
      draft,
      originalBaseDraft: originalBaseDraftRef.current,
      previousBaseRevision: activeBaseRevision,
      previousDraftToken: activeDraftToken,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    });
    setDirty(true);
    setSaveState('failed');
    resetValidation();
    dispatchConflict({
      localBaseRevision: activeBaseRevision,
      localDraft: draft,
      localDraftToken: activeDraftToken,
      originalBaseDraft: originalBaseDraftRef.current,
      type: 'CONFLICT_DETECTED',
    });
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_SETTINGS_DRAFT_UNAVAILABLE');
      dispatchConflict({
        serverBaseRevision: latest.baseRevision,
        serverDraft: latest.draft,
        serverDraftToken: latest.draftToken,
        type: 'REFRESH_SERVER_SUCCEEDED',
      });
    } catch {
      dispatchConflict({ type: 'REFRESH_SERVER_FAILED' });
    }
  }, [
    activeBaseRevision,
    activeDraftToken,
    data,
    dispatchConflict,
    draft,
    mutate,
    originalBaseDraftRef,
    resetValidation,
    setDirty,
    setSaveState,
  ]);

  const refreshConflictServer = useCallback(async () => {
    dispatchConflict({ type: 'REFRESH_SERVER_STARTED' });
    try {
      const latest = await mutate();
      if (!latest) throw new Error('LATEST_SETTINGS_DRAFT_UNAVAILABLE');
      dispatchConflict({
        serverBaseRevision: latest.baseRevision,
        serverDraft: latest.draft,
        serverDraftToken: latest.draftToken,
        type: 'REFRESH_SERVER_SUCCEEDED',
      });
    } catch {
      dispatchConflict({ type: 'REFRESH_SERVER_FAILED' });
    }
  }, [dispatchConflict, mutate]);

  const handleRebase = useCallback(() => {
    if (!data || conflictState.phase !== 'conflict') return;
    const next = reduceConflict(conflictState, { type: 'REBASE' });
    dispatchConflict({ type: 'REBASE' });
    clearConflictDraft();
    clearLocalDraft(data.registryVersion, activeBaseRevision);
    setActiveBaseRevision(next.serverBaseRevision);
    setActiveDraftToken(next.serverDraftToken ?? '');
    setDraft(next.localDraft);
    setDirty(true);
    setSaveState('idle');
    setSaveError(null);
    setValidationMsg(null);
    setImpact(null);
    resetValidation();
    originalBaseDraftRef.current = next.serverDraft;
    saveLocalDraft({
      baseRevision: next.serverBaseRevision,
      draft: next.localDraft,
      draftToken: next.serverDraftToken ?? '',
      originalBaseDraft: next.serverDraft,
      registryVersion: data.registryVersion,
      savedAt: new Date().toISOString(),
    });
  }, [
    activeBaseRevision,
    conflictState,
    data,
    dispatchConflict,
    originalBaseDraftRef,
    resetValidation,
    setActiveBaseRevision,
    setActiveDraftToken,
    setDirty,
    setDraft,
    setImpact,
    setSaveError,
    setSaveState,
    setValidationMsg,
  ]);

  const handleDiscardConflict = useCallback(() => {
    if (!data || conflictState.phase !== 'conflict') return;
    const next = reduceConflict(conflictState, { type: 'DISCARD' });
    dispatchConflict({ type: 'DISCARD' });
    clearConflictDraft();
    clearLocalDraft(data.registryVersion, activeBaseRevision);
    clearLocalDraft(data.registryVersion, next.serverBaseRevision);
    setActiveBaseRevision(next.serverBaseRevision);
    setActiveDraftToken(next.serverDraftToken ?? '');
    setDraft(next.serverDraft);
    setDirty(false);
    setSaveState('idle');
    setSaveError(null);
    setValidationMsg(null);
    setImpact(null);
    resetValidation();
    originalBaseDraftRef.current = next.serverDraft;
  }, [
    activeBaseRevision,
    conflictState,
    data,
    dispatchConflict,
    originalBaseDraftRef,
    resetValidation,
    setActiveBaseRevision,
    setActiveDraftToken,
    setDirty,
    setDraft,
    setImpact,
    setSaveError,
    setSaveState,
    setValidationMsg,
  ]);

  return {
    enterRevisionConflict,
    handleDiscardConflict,
    handleRebase,
    refreshConflictServer,
  };
};
