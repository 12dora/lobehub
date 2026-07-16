/**
 * One-to-one map: registered path → user control surface that must render managed metadata.
 * U3: every registry path with an existing control is listed here; the registration test
 * asserts imports exist in those files.
 */
export const PLATFORM_SETTING_CONTROL_WIRING = [
  {
    path: 'general.telemetry',
    surfaceFile: 'src/routes/(main)/settings/about/features/Analytics.tsx',
  },
  {
    path: 'memory.enabled',
    surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
  },
  {
    path: 'memory.effort',
    surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
  },
] as const;

export type PlatformSettingControlWiring = (typeof PLATFORM_SETTING_CONTROL_WIRING)[number];
