/**
 * Shared page-size clamp for platform catalog list queries.
 *
 * List endpoints accept an optional caller-supplied `limit`; this bounds it to a sane range so a
 * missing value falls back to {@link PLATFORM_DEFAULT_PAGE_SIZE} and an oversized one is capped at
 * {@link PLATFORM_MAX_PAGE_SIZE}. A few endpoints (e.g. bulk materialization scans) pass their own
 * larger default/max via the optional arguments.
 */
export const PLATFORM_DEFAULT_PAGE_SIZE = 50;
export const PLATFORM_MAX_PAGE_SIZE = 100;

export const boundedLimit = (
  limit?: number,
  defaultSize: number = PLATFORM_DEFAULT_PAGE_SIZE,
  maxSize: number = PLATFORM_MAX_PAGE_SIZE,
): number => Math.max(1, Math.min(limit ?? defaultSize, maxSize));
