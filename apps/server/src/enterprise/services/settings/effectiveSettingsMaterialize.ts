import type { PlatformSettingsModel } from '@/database/models/platform';

import {
  type PublishedPolicyMap,
  readPublishedPoliciesCache,
  writePublishedPoliciesCache,
} from './effectiveSettingsCache';
import { overrideRowsToMap, publishedRowsToPolicyMap } from './effectiveSettingsMaps';

export interface MaterializedUserSettingsLayers {
  overrides: Record<string, { value: unknown }>;
  platformRevision: number;
  policies: PublishedPolicyMap;
  userOverrideRevision: number;
}

/**
 * Load published policies + user overrides coherently for one user.
 *
 * Hot path: process-cached policies by platform revision + skip override reads
 * when userOverrideRevision is 0. Bracket with a closing token read when any
 * row SELECT ran; on sustained mismatch fall back to a single-statement snapshot
 * (never throw SETTINGS_SNAPSHOT_RETRY to the caller).
 */
export async function materializeUserSettingsLayers(params: {
  model: PlatformSettingsModel;
  seedRevisions: { platformRevision: number; userOverrideRevision: number };
  userId: string;
}): Promise<MaterializedUserSettingsLayers> {
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const before =
      attempt === 0 ? params.seedRevisions : await params.model.getRevisionTokens(params.userId);

    let policyMap = readPublishedPoliciesCache(before.platformRevision);
    let loadedPoliciesFromDb = false;
    if (!policyMap) {
      const rows = await params.model.listPublishedPolicies();
      policyMap = publishedRowsToPolicyMap(rows);
      loadedPoliciesFromDb = true;
    }

    // Revision 0 means the user has never written overrides (bump is transactional
    // with every insert/delete). Skip the empty SELECT on the common first-read path.
    let overrideRows: Awaited<ReturnType<PlatformSettingsModel['listUserOverrides']>> = [];
    let loadedOverridesFromDb = false;
    if (before.userOverrideRevision > 0) {
      overrideRows = await params.model.listUserOverrides(params.userId);
      loadedOverridesFromDb = true;
    }

    // Cached policies for revision R plus empty overrides at user rev 0 need no
    // recheck: concurrent publish advances the platform token (next probe misses),
    // and concurrent first patch advances the user token the same way.
    const needsRecheck = loadedPoliciesFromDb || loadedOverridesFromDb;
    if (needsRecheck) {
      const after = await params.model.getRevisionTokens(params.userId);
      if (
        before.platformRevision !== after.platformRevision ||
        before.userOverrideRevision !== after.userOverrideRevision
      ) {
        continue;
      }
      if (loadedPoliciesFromDb) {
        writePublishedPoliciesCache(before.platformRevision, policyMap);
      }
    }

    return {
      overrides: overrideRowsToMap(overrideRows),
      platformRevision: before.platformRevision,
      policies: policyMap,
      userOverrideRevision: before.userOverrideRevision,
    };
  }

  // Sustained churn: one statement-level snapshot — coherent and never throws
  // SETTINGS_SNAPSHOT_RETRY (settings reads must not become an outage mode).
  const snapshot = await params.model.readEffectiveSettingsSnapshot({ userId: params.userId });
  const policies = publishedRowsToPolicyMap(snapshot.published);
  writePublishedPoliciesCache(snapshot.platformRevision, policies);
  return {
    overrides: overrideRowsToMap(snapshot.overrideRows),
    platformRevision: snapshot.platformRevision,
    policies,
    userOverrideRevision: snapshot.userOverrideRevision,
  };
}
