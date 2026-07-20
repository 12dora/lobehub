const DEFAULT_PLATFORM_CONFIG_CACHE_TTL_SECONDS = 30;
const MIN_PLATFORM_CONFIG_CACHE_TTL_SECONDS = 1;
const MAX_PLATFORM_CONFIG_CACHE_TTL_SECONDS = 300;

export const PLATFORM_CONFIG_CACHE_TTL_BOUNDS = {
  defaultSeconds: DEFAULT_PLATFORM_CONFIG_CACHE_TTL_SECONDS,
  maxSeconds: MAX_PLATFORM_CONFIG_CACHE_TTL_SECONDS,
  minSeconds: MIN_PLATFORM_CONFIG_CACHE_TTL_SECONDS,
} as const;

const parseTtlSeconds = (value: string | undefined): number => {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return DEFAULT_PLATFORM_CONFIG_CACHE_TTL_SECONDS;
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_PLATFORM_CONFIG_CACHE_TTL_SECONDS;

  return Math.min(
    MAX_PLATFORM_CONFIG_CACHE_TTL_SECONDS,
    Math.max(MIN_PLATFORM_CONFIG_CACHE_TTL_SECONDS, parsed),
  );
};

/** Read lazily so importing runtime-config code never validates or captures process env. */
export const getPlatformConfigCacheTtlMs = (
  env: Pick<NodeJS.ProcessEnv, 'PLATFORM_CONFIG_CACHE_TTL_SECONDS'> = process.env,
): number => parseTtlSeconds(env.PLATFORM_CONFIG_CACHE_TTL_SECONDS) * 1000;
