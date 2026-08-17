/**
 * Build the leftover legacy blob for updateSettings (unregistered known leaves).
 */

import { flattenLeaves } from './pathUtils';
import type { SettingsRegistry } from './registry';

export const buildLegacySettingsPartial = (
  validatedInput: Record<string, unknown>,
  registry: SettingsRegistry,
): Record<string, unknown> => {
  const legacyPartial: Record<string, unknown> = {};
  for (const [topKey, topVal] of Object.entries(validatedInput)) {
    if (topKey === 'keyVaults') continue;
    if (registry.isSecretPath(topKey)) continue;

    const topRegistered = registry.paths().some((p) => p === topKey || p.startsWith(`${topKey}.`));
    if (!topRegistered) {
      legacyPartial[topKey] = topVal;
      continue;
    }
    const nestedLeaves = flattenLeaves(topVal, topKey);
    const unregistered = nestedLeaves.filter((l) => !registry.has(l.path));
    if (unregistered.length === 0) continue;
    let partial: Record<string, unknown> = {};
    for (const leaf of unregistered) {
      const rel = leaf.path.startsWith(`${topKey}.`)
        ? leaf.path.slice(topKey.length + 1)
        : leaf.path;
      if (!rel || rel === topKey) {
        partial = leaf.value as Record<string, unknown>;
      } else {
        const parts = rel.split('.');
        let cur = partial;
        for (let i = 0; i < parts.length - 1; i++) {
          const k = parts[i]!;
          cur[k] = cur[k] && typeof cur[k] === 'object' ? { ...(cur[k] as object) } : {};
          cur = cur[k] as Record<string, unknown>;
        }
        cur[parts.at(-1)!] = leaf.value;
      }
    }
    if (Object.keys(partial).length > 0) legacyPartial[topKey] = partial;
  }
  return legacyPartial;
};
