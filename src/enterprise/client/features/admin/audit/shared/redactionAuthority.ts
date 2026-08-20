/**
 * Explicit redaction-profile state machine for live/topic/timeline audit views.
 *
 * - Effective profile only ever tightens on observation (max of everything seen
 *   this mount).
 * - It loosens only after every slot that has ever reported a value currently
 *   agrees on the looser profile (converged confirmation). Evicted/in-flight
 *   slots do not count as agreement.
 * - Disagreement (a present source looser than effective) suppresses that
 *   envelope's evidence and triggers at most one global purge per epoch.
 */

import type { AuditRedactionProfile } from './liveMessageUtils';
import { pickMostRestrictiveRedactionProfile, rankRedactionProfile } from './liveMessageUtils';

export interface RedactionAuthorityMemory {
  /** Sticky floor: max observed this mount; loosened only on full convergence. */
  effective: AuditRedactionProfile | undefined;
  /** Slot indices that have ever produced a defined profile this mount. */
  seenSlots: boolean[];
}

export interface RedactionAuthorityView {
  disagreement: boolean;
  effective: AuditRedactionProfile | undefined;
  /** False when this envelope is looser than `effective` — suppress its items. */
  isEnvelopeRenderable: (envelopeProfile: string | null | undefined) => boolean;
  /** `${effective}|disagree` while sources disagree; null when converged. */
  purgeEpoch: string | null;
}

export const emptyRedactionAuthorityMemory = (): RedactionAuthorityMemory => ({
  effective: undefined,
  seenSlots: [],
});

export const isRedactionEnvelopeRenderable = (
  envelopeProfile: string | null | undefined,
  effective: AuditRedactionProfile | undefined,
): boolean => {
  if (effective == null || effective === 'off') return true;
  const envelopeRank = rankRedactionProfile(envelopeProfile);
  // Missing envelope profile is not "looser" — metadata-only rows, tests without a field.
  if (envelopeRank === undefined) return true;
  const effectiveRank = rankRedactionProfile(effective);
  return effectiveRank !== undefined && envelopeRank >= effectiveRank;
};

const profilesAgree = (profiles: readonly string[]): boolean => {
  if (profiles.length === 0) return false;
  const first = rankRedactionProfile(profiles[0]);
  return profiles.every((profile) => rankRedactionProfile(profile) === first);
};

/**
 * Pure step. Callers persist `memory` across renders (ref) and reset it on
 * user/topic identity change.
 */
export const reduceRedactionAuthority = (
  memory: RedactionAuthorityMemory,
  sources: ReadonlyArray<string | null | undefined>,
): { memory: RedactionAuthorityMemory; view: RedactionAuthorityView } => {
  const seenSlots = sources.map((source, index) => {
    const previously = memory.seenSlots[index] === true;
    return previously || (source != null && source !== '');
  });

  const present = sources.filter((source): source is string => source != null && source !== '');
  const observedMax = pickMostRestrictiveRedactionProfile(present);

  let effective = memory.effective;
  if (observedMax !== undefined) {
    const observedRank = rankRedactionProfile(observedMax);
    const effectiveRank = rankRedactionProfile(effective);
    if (effective === undefined || (observedRank !== undefined && effectiveRank === undefined)) {
      effective = observedMax;
    } else if (
      observedRank !== undefined &&
      effectiveRank !== undefined &&
      observedRank > effectiveRank
    ) {
      effective = observedMax;
    } else if (
      observedRank !== undefined &&
      effectiveRank !== undefined &&
      observedRank < effectiveRank
    ) {
      const allSeenSlotsPresent = seenSlots.every((seen, index) => {
        if (!seen) return true;
        const source = sources[index];
        return source != null && source !== '';
      });
      if (allSeenSlotsPresent && profilesAgree(present)) {
        effective = observedMax;
      }
    }
  }

  const effectiveRank = rankRedactionProfile(effective);
  const disagreement =
    effectiveRank !== undefined &&
    present.some((profile) => {
      const rank = rankRedactionProfile(profile);
      return rank !== undefined && rank < effectiveRank;
    });

  const purgeEpoch = effective !== undefined && disagreement ? `${effective}|disagree` : null;

  return {
    memory: { effective, seenSlots },
    view: {
      disagreement,
      effective,
      isEnvelopeRenderable: (envelopeProfile) =>
        isRedactionEnvelopeRenderable(envelopeProfile, effective),
      purgeEpoch,
    },
  };
};
