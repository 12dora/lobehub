/**
 * Exact skip multiset semantics for pen-regression adapters.
 *
 * - expectedSkips forms a multiset of titles (each entry = one occurrence).
 * - Entries with required:false may be absent (count 0..expected); required (default)
 *   entries must match exactly.
 * - No unexpected titles; no excess duplicates beyond expected counts.
 */

export interface ExpectedSkipSpec {
  reason: string;
  /** When false, absence is allowed (0..count); presence still capped at count. Default true. */
  required?: boolean;
  title: string;
}

export type SkipMultisetVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing-approved-skip' | 'unexpected-skip' | 'skip-multiplicity' };

const countTitles = (titles: readonly string[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const title of titles) {
    map.set(title, (map.get(title) ?? 0) + 1);
  }
  return map;
};

/**
 * Build expected multiset + required-min from definition list.
 * Duplicate titles in expectedSkips increase the allowed/required count.
 */
export const expectedSkipBounds = (
  expected: readonly ExpectedSkipSpec[],
): { max: Map<string, number>; min: Map<string, number> } => {
  const max = new Map<string, number>();
  const min = new Map<string, number>();
  for (const skip of expected) {
    max.set(skip.title, (max.get(skip.title) ?? 0) + 1);
    if (skip.required !== false) {
      min.set(skip.title, (min.get(skip.title) ?? 0) + 1);
    }
  }
  return { max, min };
};

/**
 * Validate observed skipped titles against expected skip multiset bounds.
 */
export const validateSkipMultiset = (
  observedTitles: readonly string[],
  expected: readonly ExpectedSkipSpec[],
): SkipMultisetVerdict => {
  const observed = countTitles(observedTitles);
  const { max, min } = expectedSkipBounds(expected);

  // Unexpected titles
  for (const title of observed.keys()) {
    if (!max.has(title)) {
      return { ok: false, reason: 'unexpected-skip' };
    }
  }

  // Excess multiplicity
  for (const [title, count] of observed) {
    const allowed = max.get(title) ?? 0;
    if (count > allowed) {
      return { ok: false, reason: 'skip-multiplicity' };
    }
  }

  // Missing required
  for (const [title, requiredCount] of min) {
    const got = observed.get(title) ?? 0;
    if (got < requiredCount) {
      return { ok: false, reason: 'missing-approved-skip' };
    }
  }

  // When expected list is empty, observed must be empty (already covered by unexpected).
  return { ok: true };
};

/**
 * Strict exact multiset equality (all expected required). Used when every entry is required.
 */
export const validateSkipMultisetExact = (
  observedTitles: readonly string[],
  expectedTitles: readonly string[],
): SkipMultisetVerdict =>
  validateSkipMultiset(
    observedTitles,
    expectedTitles.map((title) => ({ reason: 'expected', required: true, title })),
  );
