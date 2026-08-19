import { isRecord } from '@lobechat/utils/object';
import { eq, inArray } from 'drizzle-orm';

import { PlatformSettingsModel } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgents,
  platformSettingPolicies,
  platformSettingsBundle,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import type { AiCatalogDependent } from './errors';

export interface ForceDisabledDependents {
  agents: { id: string; title: string }[];
  settings: string[];
}

export interface ForceDisableLockSet {
  agentIds: ReadonlySet<string>;
  settingsBundle: boolean;
}

export const EMPTY_FORCE_DISABLE_LOCKS: ForceDisableLockSet = {
  agentIds: new Set(),
  settingsBundle: false,
};

interface ClearedValue {
  changed: boolean;
  empty: boolean;
  value: unknown;
}

const jsonContainsRemovedModelReference = (
  value: unknown,
  removedByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsRemovedModelReference(item, removedByProvider));
  }
  if (!isRecord(value)) return false;
  if (typeof value.provider === 'string' && typeof value.model === 'string') {
    const models = removedByProvider.get(value.provider);
    if (models?.has(value.model)) return true;
  }
  return Object.values(value).some((item) =>
    jsonContainsRemovedModelReference(item, removedByProvider),
  );
};

/**
 * Strip matching provider/model pairs. A child is dropped only when it became
 * empty because of a removal inside it (`empty && changed`). Pre-existing empty
 * objects/arrays (`empty && !changed`) stay in place. The root is `empty` only
 * when nothing remains after those removals — that is the delete-the-row signal.
 */
export const clearRemovedModelReferences = (
  value: unknown,
  removedByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): ClearedValue => {
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const item of value) {
      const child = clearRemovedModelReferences(item, removedByProvider);
      if (child.changed) changed = true;
      // Drop only if this element was emptied by a removal, not if it was already [].
      if (child.empty && child.changed) continue;
      next.push(child.value);
    }
    return { changed, empty: next.length === 0, value: next };
  }
  if (!isRecord(value)) return { changed: false, empty: false, value };

  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const child = clearRemovedModelReferences(item, removedByProvider);
    if (child.changed) changed = true;
    // Drop only if this field was emptied by a removal, not if it was already {}.
    if (child.empty && child.changed) continue;
    next[key] = child.value;
  }
  if (typeof next.provider === 'string' && typeof next.model === 'string') {
    const models = removedByProvider.get(next.provider);
    if (models?.has(next.model)) {
      delete next.provider;
      delete next.model;
      changed = true;
    }
  }
  return { changed, empty: Object.keys(next).length === 0, value: next };
};

const pairedSiblingMatches = (
  path: string,
  value: string,
  policies: ReadonlyMap<string, unknown>,
  removedByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  if (path.endsWith('.provider')) {
    const model = policies.get(`${path.slice(0, -'.provider'.length)}.model`);
    return typeof model === 'string' && Boolean(removedByProvider.get(value)?.has(model));
  }
  if (path.endsWith('.model')) {
    const provider = policies.get(`${path.slice(0, -'.model'.length)}.provider`);
    return typeof provider === 'string' && Boolean(removedByProvider.get(provider)?.has(value));
  }
  return false;
};

const policyReferencesRemoved = (
  path: string,
  value: unknown,
  policies: ReadonlyMap<string, unknown>,
  removedByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): boolean => {
  if (typeof value === 'string') {
    return pairedSiblingMatches(path, value, policies, removedByProvider);
  }
  return jsonContainsRemovedModelReference(value, removedByProvider);
};

const candidateSettingPaths = (dependents: readonly AiCatalogDependent[]): string[] => {
  const paths = new Set<string>();
  for (const dependent of dependents) {
    if (dependent.resourceType !== 'setting') continue;
    paths.add(dependent.resourceId);
    paths.add(`${dependent.resourceId}.provider`);
    paths.add(`${dependent.resourceId}.model`);
  }
  return [...paths];
};

/**
 * Lock foreign rows in the same order their own publishers use, BEFORE the shared
 * advisory lock: agent identity `FOR UPDATE` (sorted), then settings bundle
 * `FOR UPDATE`. Agent publish is identity → advisory; settings publish is
 * `lockAndGetRevision` (bundle) → advisory. Taking those row locks first means a
 * concurrent publisher waits on the row we already hold instead of holding the
 * row and waiting on the advisory lock we are about to take.
 */
export const lockForceDisableTargets = async (
  tx: Transaction,
  dependents: readonly AiCatalogDependent[],
): Promise<ForceDisableLockSet> => {
  const agentIds = [
    ...new Set(
      dependents.filter((item) => item.resourceType === 'agent').map((item) => item.resourceId),
    ),
  ].sort();
  const repository = new PlatformAgentCatalogRepository(tx);
  for (const id of agentIds) {
    await repository.lockIdentity(id);
  }
  const hasSettings = dependents.some((item) => item.resourceType === 'setting');
  if (hasSettings) {
    await new PlatformSettingsModel(tx).lockBundleForUpdate();
  }
  return { agentIds: new Set(agentIds), settingsBundle: hasSettings };
};

/**
 * Quarantine published dependents of models being removed.
 *
 * Callers must already hold: provider row, the locks from {@link lockForceDisableTargets}
 * (agent identities then settings bundle), and `acquirePlatformDependencyPublicationLock`.
 *
 * Settings: delete a policy when the whole value was a removed provider/model reference
 * (or collapses to empty). `resolveSettingPath` treats a missing policy as builtin/env
 * default — writing `null` with `mode: 'default'` would publish `null` to every user.
 * Nested objects are updated in place only when leftover keys remain. Bundle revision
 * is incremented in this transaction so `EffectiveSettingsService` (keyed by
 * `platformSettingsBundle.revision`, no TTL on the published-policy map) observes the
 * change on the next read.
 */
export const forceResolveAiCatalogDependents = async (
  tx: Transaction,
  dependents: readonly AiCatalogDependent[],
  removedByProvider: ReadonlyMap<string, ReadonlySet<string>>,
  actorUserId: string,
): Promise<ForceDisabledDependents> => {
  const agentDependents = dependents.filter((item) => item.resourceType === 'agent');
  const settingDependents = dependents.filter((item) => item.resourceType === 'setting');
  const now = new Date();

  if (agentDependents.length > 0) {
    // Draft + null publishedAt + migrationRequired: CHECK
    // `platform_agents_published_pointer_check` (and the matching trigger) forbids
    // migrationRequired=true while status='published'. Same quarantine used by the
    // M01→M10 upgrade for orphaned platform agents.
    await tx
      .update(platformAgents)
      .set({
        migrationRequired: true,
        publishedAt: null,
        status: 'draft',
        updatedAt: now,
        updatedBy: actorUserId,
      })
      .where(
        inArray(
          platformAgents.id,
          agentDependents.map((item) => item.resourceId),
        ),
      );
  }

  const settingPaths = candidateSettingPaths(settingDependents);
  if (settingPaths.length > 0) {
    const policies = await tx
      .select()
      .from(platformSettingPolicies)
      .where(inArray(platformSettingPolicies.path, settingPaths));
    const valueByPath = new Map(policies.map((policy) => [policy.path, policy.value]));
    const toDelete: string[] = [];
    const toUpdate: { path: string; value: unknown }[] = [];

    for (const policy of policies) {
      if (!policyReferencesRemoved(policy.path, policy.value, valueByPath, removedByProvider)) {
        continue;
      }
      if (typeof policy.value === 'string') {
        toDelete.push(policy.path);
        continue;
      }
      const cleared = clearRemovedModelReferences(policy.value, removedByProvider);
      if (!cleared.changed) continue;
      if (cleared.empty) toDelete.push(policy.path);
      else toUpdate.push({ path: policy.path, value: cleared.value });
    }

    if (toDelete.length > 0) {
      await tx
        .delete(platformSettingPolicies)
        .where(inArray(platformSettingPolicies.path, toDelete));
    }
    for (const item of toUpdate) {
      await tx
        .update(platformSettingPolicies)
        .set({
          updatedAt: now,
          updatedBy: actorUserId,
          value: item.value,
        })
        .where(eq(platformSettingPolicies.path, item.path));
    }

    if (toDelete.length > 0 || toUpdate.length > 0) {
      const settings = new PlatformSettingsModel(tx);
      const bundle = await settings.getBundle();
      const nextDraft = { ...bundle?.draft };
      for (const path of toDelete) delete nextDraft[path];
      for (const item of toUpdate) {
        const previous = nextDraft[item.path];
        if (!previous) continue;
        nextDraft[item.path] = { ...previous, value: item.value };
      }
      if (bundle) {
        await settings.saveDraft({ draft: nextDraft, updatedBy: actorUserId });
        // Same pointer bump a settings publish does via updatePointer. Cache keys
        // are this integer; invalidation events do not drop EffectiveSettingsService.
        await tx
          .update(platformSettingsBundle)
          .set({
            revision: bundle.revision + 1,
            updatedAt: now,
            updatedBy: actorUserId,
          })
          .where(eq(platformSettingsBundle.id, bundle.id));
      }
    }
  }

  return {
    agents: agentDependents.map((item) => ({ id: item.resourceId, title: item.label })),
    settings: settingDependents.map((item) => item.resourceId),
  };
};
