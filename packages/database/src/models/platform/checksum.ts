import { createHash } from 'node:crypto';

/**
 * Canonical SHA-256 checksum for a redacted revision payload.
 * Keys are sorted so semantically equal objects produce stable digests.
 */
export const checksumPayload = (payload: unknown): string => {
  const canonical = JSON.stringify(sortKeys(payload));
  return createHash('sha256').update(canonical).digest('hex');
};

const sortKeys = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
};
