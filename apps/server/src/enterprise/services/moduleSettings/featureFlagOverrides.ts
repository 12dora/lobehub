/**
 * Force upstream FEATURE_FLAGS keys off when the owning platform module is
 * disabled. Self-contained (G3); G1 owns the rest of this directory.
 */
import type { IFeatureFlags } from '@/config/featureFlags';
import { PLATFORM_MODULE_IDS, PLATFORM_MODULES } from '@/const/platform/modules';

import { getModuleSettingsSnapshot } from './index';

export const applyDisabledModuleFeatureFlagOverrides = async (
  flags: IFeatureFlags,
): Promise<IFeatureFlags> => {
  const { effective } = await getModuleSettingsSnapshot();
  const next: IFeatureFlags = { ...flags };
  let changed = false;

  for (const id of PLATFORM_MODULE_IDS) {
    if (effective[id]) continue;
    for (const key of PLATFORM_MODULES[id].featureFlagKeys) {
      if (next[key as keyof IFeatureFlags] === false) continue;
      next[key as keyof IFeatureFlags] = false;
      changed = true;
    }
  }

  return changed ? next : flags;
};
