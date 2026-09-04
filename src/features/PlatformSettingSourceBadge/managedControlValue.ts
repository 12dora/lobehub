import { type PlatformSettingMetaState } from './usePlatformSettingMeta';

/**
 * Value a locked boolean control must render. `locked` is fail-closed (also true while the
 * policy loads or errored), so an unknown enforced value falls back to `fallback` rather than
 * to the store snapshot — a newly enforced `false` must never render as disabled-but-ON.
 */
export const resolveManagedBoolean = (
  meta: PlatformSettingMetaState,
  storedValue: boolean,
  fallback = false,
): boolean => {
  if (!meta.locked) return storedValue;

  return typeof meta.effectiveValue === 'boolean' ? meta.effectiveValue : fallback;
};
