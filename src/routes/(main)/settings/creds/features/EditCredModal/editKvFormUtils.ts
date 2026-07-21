/**
 * Pure helpers for EditKVForm — unit-tested without mounting the modal tree.
 */

export type KvPair = { key: string; value: string };

/**
 * Build update.values from form pairs.
 * Empty value fields are omitted (keep existing secret on platform / skip empty market rows).
 * Returns undefined when nothing would rotate — caller should omit `values` on the wire.
 */
export const buildKvUpdateValues = (
  kvPairs: KvPair[] | undefined,
): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const pair of kvPairs ?? []) {
    if (pair.key && pair.value) {
      values[pair.key] = pair.value;
    }
  }
  return Object.keys(values).length > 0 ? values : undefined;
};

/**
 * Platform mode: show known key names with empty values so the admin cannot
 * accidentally re-submit the M13 mask string as a new secret.
 */
export const platformPrefillKvPairs = (valueKeys: string[] | undefined): KvPair[] => {
  const keys = (valueKeys ?? []).filter(Boolean);
  if (keys.length === 0) return [{ key: '', value: '' }];
  return keys.map((key) => ({ key, value: '' }));
};

/** Market mode: convert decrypted plaintext map into form pairs. */
export const marketPrefillKvPairs = (plaintext: Record<string, string> | undefined): KvPair[] => {
  const entries = Object.entries(plaintext ?? {});
  if (entries.length === 0) return [{ key: '', value: '' }];
  return entries.map(([key, value]) => ({ key, value: String(value) }));
};
