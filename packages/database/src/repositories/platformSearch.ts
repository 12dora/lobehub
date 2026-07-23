/**
 * Shared LIKE/ILIKE helpers for platform catalog search.
 *
 * Admin/user search boxes are literal "contains" searches, so raw input must have its LIKE
 * metacharacters escaped — otherwise a `%` or `_` typed by the user is treated as a wildcard and
 * a `\` can corrupt the pattern. Uses the default PostgreSQL `\` escape character.
 */
export const escapeLike = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** Build a case-insensitive "contains" ILIKE pattern from raw user input (wildcards escaped). */
export const likeContains = (value: string): string => `%${escapeLike(value)}%`;
