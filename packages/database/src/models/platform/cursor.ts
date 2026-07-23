/**
 * Shared keyset cursor helpers for platform audit list endpoints.
 *
 * Contract: `${createdAt|sortAt.toISOString()}|${id}` with limit clamped to 1..200.
 */

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

/** Clamp a page size to [1, max] with a default when omitted/invalid. */
export const clampListLimit = (
  limit?: number,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  max: number = MAX_LIST_LIMIT,
): number => Math.min(Math.max(Math.floor(limit ?? defaultLimit), 1), max);

/** Encode a composite keyset cursor from a timestamp + stable id. */
export const encodeCompositeCursor = (at: Date, id: string): string => `${at.toISOString()}|${id}`;

/**
 * Parse a composite `${iso}|${id}` keyset cursor.
 * Returns null for missing, malformed, or non-finite timestamps.
 */
export const parseCompositeCursor = (
  cursor: string | undefined,
): { at: Date; id: string } | null => {
  if (!cursor?.includes('|')) return null;
  const [iso, id] = cursor.split('|');
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || !id) return null;
  return { at, id };
};

/** Convenience for createdAt-keyed lists (most audit models). */
export const encodeCreatedAtCursor = (row: { createdAt: Date; id: string }): string =>
  encodeCompositeCursor(row.createdAt, row.id);

export const parseCreatedAtCursor = (
  cursor: string | undefined,
): { createdAt: Date; id: string } | null => {
  const parsed = parseCompositeCursor(cursor);
  return parsed ? { createdAt: parsed.at, id: parsed.id } : null;
};
