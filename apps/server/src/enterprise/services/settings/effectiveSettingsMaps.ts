import type { SettingPolicyMode, SettingPolicyVisibility } from '@/types/platform/settings';

import type { PublishedPolicyMap } from './effectiveSettingsCache';

export interface PublishedPolicyRow {
  mode: string;
  path: string;
  schemaVersion: number;
  value: unknown;
  visibility?: string | null;
}

export function publishedRowsToPolicyMap(rows: readonly PublishedPolicyRow[]): PublishedPolicyMap {
  const policies: PublishedPolicyMap = {};
  for (const row of rows) {
    policies[row.path] = {
      mode: row.mode as SettingPolicyMode,
      schemaVersion: row.schemaVersion,
      value: row.value,
      visibility: (row.visibility ?? 'visible') as SettingPolicyVisibility,
    };
  }
  return policies;
}

export function overrideRowsToMap(
  rows: ReadonlyArray<{ path: string; value: unknown }>,
): Record<string, { value: unknown }> {
  const overrides: Record<string, { value: unknown }> = {};
  for (const row of rows) {
    overrides[row.path] = { value: row.value };
  }
  return overrides;
}
