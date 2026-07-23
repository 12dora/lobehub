/**
 * Deterministic canonicalization for fingerprinting editor drafts: recursively sort object keys so
 * two structurally-equal values serialize identically regardless of key insertion order. Shared by
 * the admin AI / connectors / settings-policy controllers, which previously each defined an
 * identical copy.
 */
export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};
