/**
 * Pure decision helper for 基础设施 draft rehydration.
 *
 * The infrastructure cards share one SWR key that revalidates on every reconnect and on every
 * save of a *sibling* card. Without this guard a background refresh would replace what an admin
 * is typing; with it the local draft always wins and the page reports that the server moved.
 *
 * Mirrors `generalSettings/generalSettingsHydration.ts` — same contract, generic over the draft.
 */
export type InfraHydrationDecision = { action: 'accept' } | { action: 'keep'; markStale: boolean };

export const decideInfraHydration = (params: {
  /** Fingerprint of the last accepted server snapshot; null before the first hydrate. */
  baselineFp: string | null;
  /** Fingerprint of what is on screen; null before the first hydrate. */
  draftFp: string | null;
  /** Force-accept the incoming snapshot (explicit reload after a conflict / discard). */
  force?: boolean;
  /** Fingerprint of the incoming server snapshot. */
  nextFp: string;
  /** A save is in flight — never swap the payload under it. */
  saving: boolean;
}): InfraHydrationDecision => {
  if (params.force) return { action: 'accept' };

  // First hydrate (or remount with empty local state).
  if (params.baselineFp === null || params.draftFp === null) return { action: 'accept' };

  // Same server snapshot as the editor baseline — ignore identity churn.
  if (params.nextFp === params.baselineFp) return { action: 'keep', markStale: false };

  const dirty = params.draftFp !== params.baselineFp;
  if (!dirty && !params.saving) return { action: 'accept' };

  // Retain local edits; surface that the server moved under the editor.
  return { action: 'keep', markStale: true };
};
