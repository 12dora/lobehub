import type { Dispatch, SetStateAction } from 'react';

import { type EditableSkillDraft, fingerprintSkillDraft, type SkillSaveState } from '../controller';
import type { StoredSkillDraft } from '../localDraftStorage';
import type { AdminSkillGetOutput } from '../types';

/** The exact server row — and read/write mode — a hydration would install. */
export const hydrationKeyOf = (snapshot: AdminSkillGetOutput, editable: boolean) =>
  `${snapshot.draft.id}:${snapshot.baseRevision}:${snapshot.draftToken}:${editable}`;

export interface SkillEditorDraftSetters {
  setActionError: Dispatch<SetStateAction<string | null>>;
  setBaseDraft: Dispatch<SetStateAction<EditableSkillDraft | null>>;
  setConflict: Dispatch<SetStateAction<boolean>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<EditableSkillDraft | null>>;
  setRecoveryBaseDraftSequence: Dispatch<SetStateAction<number | undefined>>;
  setRecoveryBaseRevision: Dispatch<SetStateAction<number | undefined>>;
  setSaveState: Dispatch<SetStateAction<SkillSaveState>>;
}

/**
 * A recovered draft is only safe on top of the row it was branched from: revision, draft
 * sequence and content all have to still match, or it is sitting on a stale base.
 */
export const isStaleLocalBase = (
  local: StoredSkillDraft,
  snapshot: AdminSkillGetOutput,
  latest: EditableSkillDraft,
) =>
  local.baseRevision !== snapshot.baseRevision ||
  local.baseDraftSequence !== snapshot.draft.draftSequence ||
  fingerprintSkillDraft(local.baseDraft) !== fingerprintSkillDraft(latest);

/**
 * Installs a recovered local draft over the server row. Rebase conflicts are left to the
 * caller, which owns whether they are cleared before or after its own bookkeeping.
 */
export const applyRecoveredSkillState = (
  setters: SkillEditorDraftSetters,
  { local, staleBase }: { local: StoredSkillDraft; staleBase: boolean },
) => {
  setters.setBaseDraft(local.baseDraft);
  setters.setRecoveryBaseRevision(local.baseRevision);
  setters.setRecoveryBaseDraftSequence(local.baseDraftSequence);
  setters.setDraft(local.draft);
  setters.setDirty(true);
  setters.setConflict(staleBase);
  setters.setSaveState('dirty');
  setters.setActionError(null);
};

/**
 * Installs the server row as both base and draft — the pristine, nothing-to-recover state.
 * Rebase conflicts are left to the caller, as above.
 */
export const applyPristineSkillState = (
  setters: SkillEditorDraftSetters,
  {
    baseDraftSequence,
    baseRevision,
    latest,
  }: { baseDraftSequence: number; baseRevision: number; latest: EditableSkillDraft },
) => {
  setters.setBaseDraft(latest);
  setters.setRecoveryBaseRevision(baseRevision);
  setters.setRecoveryBaseDraftSequence(baseDraftSequence);
  setters.setDraft(latest);
  setters.setDirty(false);
  setters.setConflict(false);
  setters.setSaveState('idle');
  setters.setActionError(null);
};
