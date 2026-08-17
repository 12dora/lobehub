/**
 * Synchronous boot view of the platform module switches.
 *
 * Reads `window.__SERVER_CONFIG__.config.enterprise.modules`, injected by the SPA HTML
 * template **before** the SPA entry evaluates (same channel as `platformAdmin`).
 *
 * **Fail-open by design.** `bun run dev:spa` talks to the Vite dev server directly, where the
 * placeholder is never substituted and `__SERVER_CONFIG__` stays `undefined`. Treating that as
 * "everything disabled" would blank the whole admin console in local development, so a missing
 * or malformed payload means `ALL_MODULES_ENABLED` — exactly today's behaviour for an
 * unconfigured deployment. The server still enforces every gate.
 */
import {
  ALL_MODULES_ENABLED,
  isPlatformModuleId,
  PLATFORM_MODULE_IDS,
  type PlatformModuleId,
  type PlatformModuleStateMap,
} from '@/const/platform/modules';

/** The payload is injected HTML, so treat it as untrusted rather than as its declared type. */
const readRawModules = (): Record<string, unknown> | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw: unknown = window.__SERVER_CONFIG__?.config?.enterprise?.modules;
    if (!raw || typeof raw !== 'object') return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Normalize an untrusted payload: only booleans count, unknown ids are ignored, missing = on. */
export const normalizeModuleStateMap = (raw: unknown): PlatformModuleStateMap => {
  if (!raw || typeof raw !== 'object') return ALL_MODULES_ENABLED;
  const source = raw as Record<string, unknown>;
  return Object.freeze(
    Object.fromEntries(PLATFORM_MODULE_IDS.map((id) => [id, source[id] === false ? false : true])),
  ) as PlatformModuleStateMap;
};

/** Boot module state. Missing server config ⇒ all modules enabled. */
export const getBootModules = (): PlatformModuleStateMap => {
  const raw = readRawModules();
  return raw ? normalizeModuleStateMap(raw) : ALL_MODULES_ENABLED;
};

/** Sync boot check for a single module. */
export const isBootModuleEnabled = (id: PlatformModuleId): boolean => getBootModules()[id];

/** Ids explicitly reported as disabled by the boot payload. */
export const getBootDisabledModules = (): Set<PlatformModuleId> => {
  const state = getBootModules();
  return new Set(PLATFORM_MODULE_IDS.filter((id) => !state[id]));
};

export { ALL_MODULES_ENABLED, isPlatformModuleId };
