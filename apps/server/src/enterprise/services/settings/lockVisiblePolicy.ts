/**
 * Canonicalize "lock visibly" policies so locked allow-listed paths never hide
 * the user control. The allow-list lives on the registry (`lockVisibly: true`);
 * this module projects it on read, persists it on write, and repairs production
 * rows at bootstrap.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { SettingsDraftPolicyMap } from '@/database/models/platform';
import { PlatformSettingsModel } from '@/database/models/platform';
import { platformSettingPolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { SettingPolicyVisibility } from '@/types/platform/settings';

import { clearAllSettingsCaches } from './effectiveSettingsCache';
import { settingsRegistry } from './registry';

const LOCK_VISIBLE_VISIBILITY: SettingPolicyVisibility = 'visible';

export const isLockVisiblyPath = (path: string): boolean =>
  settingsRegistry.isLockVisiblyPath(path);

/** Project a single policy: locked + allow-listed → visibility visible. */
export const canonicalizeLockVisiblePolicy = <
  T extends { mode: string; visibility?: string | null },
>(
  path: string,
  policy: T,
): T => {
  if (policy.mode !== 'locked' || !isLockVisiblyPath(path)) return policy;
  if (policy.visibility === LOCK_VISIBLE_VISIBILITY) return policy;
  return { ...policy, visibility: LOCK_VISIBLE_VISIBILITY };
};

/** Project a path→policy map. Returns the input reference when nothing changes. */
export const canonicalizeLockVisiblePolicyMap = <T extends SettingsDraftPolicyMap>(
  policies: T,
): T => {
  let changed = false;
  const next: SettingsDraftPolicyMap = { ...policies };
  for (const [path, policy] of Object.entries(next)) {
    if (!policy) continue;
    const canonical = canonicalizeLockVisiblePolicy(path, policy);
    if (canonical === policy) continue;
    next[path] = canonical;
    changed = true;
  }
  return (changed ? next : policies) as T;
};

/**
 * Idempotent repair of published rows left over from before lock-visible telemetry.
 * Does not bump the settings revision. No-op when nothing matches.
 */
export const repairLockVisiblePublishedPolicies = async (
  db: LobeChatDatabase,
): Promise<{ repairedPaths: string[] }> => {
  const rows = await new PlatformSettingsModel(db).listPublishedPolicies();
  const paths = rows
    .filter(
      (row) => row.mode === 'locked' && row.visibility === 'hidden' && isLockVisiblyPath(row.path),
    )
    .map((row) => row.path);

  if (paths.length === 0) return { repairedPaths: [] };

  const updated = await db
    .update(platformSettingPolicies)
    .set({ updatedAt: new Date(), visibility: LOCK_VISIBLE_VISIBILITY })
    .where(
      and(
        eq(platformSettingPolicies.mode, 'locked'),
        eq(platformSettingPolicies.status, 'published'),
        eq(platformSettingPolicies.visibility, 'hidden'),
        inArray(platformSettingPolicies.path, paths),
      ),
    )
    .returning({ path: platformSettingPolicies.path });

  const repairedPaths = updated.map((row) => row.path).sort();
  if (repairedPaths.length > 0) {
    clearAllSettingsCaches();
    console.info('[platformBootstrap] repaired lock-visible published policies', {
      paths: repairedPaths,
    });
  }
  return { repairedPaths };
};
