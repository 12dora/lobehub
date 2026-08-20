/**
 * Redaction authority (fail-closed).
 *
 * R1 — `effective` is the max of every profile observed this mount
 *      (off < standard < strict). A PRESENT envelope with a missing/unknown
 *      profile counts as strict. NEVER loosens within a mount; loosening only
 *      happens via remount / resetKey (navigation). An admin who turns
 *      redaction off sees raw bodies after navigating away and back.
 *
 * R2 — An envelope is rendered only if its own profile ≥ effective. Missing /
 *      unknown profiles are never renderable. Applied in the same render.
 *
 * R3 — When `effective` tightens (including the first render if any present
 *      envelope is looser than effective), schedule exactly one global purge
 *      for that new effective. Latch until the effect acknowledges. Do not
 *      clear the latch because sources became undefined/in-flight.
 *
 * R4 — Stable named slots. `policy` is always passed (undefined when unread).
 *      Seen-history is per name and never truncated.
 *
 * R5 — One authority per page aggregating every envelope on that page.
 */

import type { AuditRedactionProfile } from './liveMessageUtils';

export const REDACTION_SLOT_NAMES = ['list', 'detail', 'messages', 'timeline', 'policy'] as const;

export type RedactionSlotName = (typeof REDACTION_SLOT_NAMES)[number];

/** Named slots. `undefined` = not loaded; always include `policy`. */
export type RedactionSlots = Record<RedactionSlotName, string | undefined>;

/** Present envelope whose profile field is missing or not off/standard/strict. */
export const UNKNOWN_REDACTION_PROFILE = 'unknown';

export const emptyRedactionSlots = (): RedactionSlots => ({
  detail: undefined,
  list: undefined,
  messages: undefined,
  policy: undefined,
  timeline: undefined,
});

/**
 * Map a loaded envelope to a slot value. Absent envelope → `undefined`.
 * Present with a known profile → that profile. Present otherwise → `unknown`.
 */
export const envelopeSlot = (envelope: unknown): string | undefined => {
  if (envelope == null || typeof envelope !== 'object') return undefined;
  const profile = (envelope as { redactionProfile?: unknown }).redactionProfile;
  if (profile === 'off' || profile === 'standard' || profile === 'strict') return profile;
  return UNKNOWN_REDACTION_PROFILE;
};

const RANK: Record<string, number> = {
  off: 0,
  standard: 1,
  strict: 2,
};

const rank = (profile: string | undefined): number | undefined => {
  if (profile === undefined) return undefined;
  if (profile === 'off') return RANK.off;
  if (profile === 'standard') return RANK.standard;
  return RANK.strict;
};

const toEffective = (value: number): AuditRedactionProfile => {
  if (value <= RANK.off) return 'off';
  if (value === RANK.standard) return 'standard';
  return 'strict';
};

export interface RedactionAuthorityMemory {
  effective: AuditRedactionProfile | undefined;
  seen: Record<RedactionSlotName, boolean>;
}

export interface RedactionAuthorityView {
  disagreement: boolean;
  effective: AuditRedactionProfile | undefined;
  isEnvelopeRenderable: (envelopeProfile: string | undefined) => boolean;
  /** Set when this step should schedule a purge for `effective`. */
  tightenTo: AuditRedactionProfile | undefined;
}

export const emptyRedactionAuthorityMemory = (): RedactionAuthorityMemory => ({
  effective: undefined,
  seen: {
    detail: false,
    list: false,
    messages: false,
    policy: false,
    timeline: false,
  },
});

/**
 * R2. Missing/unknown profiles are never renderable. `undefined` means the
 * slot is not present (no envelope) — callers should not paint its items.
 */
export const isRedactionEnvelopeRenderable = (
  envelopeProfile: string | undefined,
  effective: AuditRedactionProfile | undefined,
): boolean => {
  if (envelopeProfile === undefined) return false;
  if (envelopeProfile !== 'off' && envelopeProfile !== 'standard' && envelopeProfile !== 'strict') {
    return false;
  }
  if (effective === undefined) return envelopeProfile === 'off';
  const envelopeRank = rank(envelopeProfile);
  const effectiveRank = rank(effective);
  return envelopeRank !== undefined && effectiveRank !== undefined && envelopeRank >= effectiveRank;
};

/** R2: drop looser pages before any merge so they never commit to the tree. */
export const selectRenderablePages = <T>(
  pages: ReadonlyArray<{ items: readonly T[]; redactionProfile: string | undefined }>,
  isRenderable: (profile: string | undefined) => boolean,
): T[] =>
  pages.filter((page) => isRenderable(page.redactionProfile)).flatMap((page) => [...page.items]);

/**
 * Pure step. Callers persist `memory` across renders and reset it on navigation.
 */
export const reduceRedactionAuthority = (
  memory: RedactionAuthorityMemory,
  slots: RedactionSlots,
  extraObserved: ReadonlyArray<string | undefined> = [],
): { memory: RedactionAuthorityMemory; view: RedactionAuthorityView } => {
  const seen: Record<RedactionSlotName, boolean> = { ...memory.seen };
  const observedRanks: number[] = [];

  for (const name of REDACTION_SLOT_NAMES) {
    const value = slots[name];
    if (value === undefined) continue;
    seen[name] = true;
    const valueRank = rank(value);
    if (valueRank !== undefined) observedRanks.push(valueRank);
  }
  for (const extra of extraObserved) {
    if (extra === undefined) continue;
    const extraRank = rank(extra);
    if (extraRank !== undefined) observedRanks.push(extraRank);
  }

  const previousRank = rank(memory.effective) ?? -1;
  let effective = memory.effective;
  if (observedRanks.length > 0) {
    const maxObserved = Math.max(...observedRanks);
    if (maxObserved > previousRank) {
      effective = toEffective(maxObserved);
    }
  }

  const effectiveRank = rank(effective);
  const isLooserThanEffective = (value: string | undefined): boolean => {
    if (value === undefined || effectiveRank === undefined) return false;
    const valueRank = rank(value);
    return valueRank !== undefined && valueRank < effectiveRank;
  };
  // Named slots + accumulated pages. Absent/in-flight (`undefined`) is not disagreement.
  const disagreement =
    effectiveRank !== undefined &&
    (REDACTION_SLOT_NAMES.some((name) => isLooserThanEffective(slots[name])) ||
      extraObserved.some((extra) => isLooserThanEffective(extra)));

  const newRank = rank(effective) ?? -1;
  const tightened = newRank > previousRank;
  // One purge per tightening of `effective`: rank increased while we already had a
  // baseline (unanimous off→strict counts), or any present envelope is already
  // looser — including the first render. The hook latches; this flag may repeat.
  const tightenTo =
    effective !== undefined && ((tightened && memory.effective !== undefined) || disagreement)
      ? effective
      : undefined;

  return {
    memory: { effective, seen },
    view: {
      disagreement,
      effective,
      isEnvelopeRenderable: (envelopeProfile) =>
        isRedactionEnvelopeRenderable(envelopeProfile, effective),
      tightenTo,
    },
  };
};
