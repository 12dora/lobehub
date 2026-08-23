import { isRecord } from '@lobechat/utils/object';

import { PlatformRevisionConflictError } from '@/database/models/platform';
import type { Transaction } from '@/database/type';

import type { resolveAiCatalogDependentsForModels } from './dependencies';
import { AiCatalogResourceInUseError } from './errors';
import {
  type ForceDisabledDependents,
  type ForceDisableLockSet,
  forceResolveAiCatalogDependents,
} from './forceDisableDependents';

export const enabledModelReferences = (payload: Record<string, unknown> | null): Set<string> => {
  if (!payload || !isRecord(payload.provider) || !Array.isArray(payload.models))
    return new Set<string>();
  const providerKey = payload.provider.providerKey;
  if (typeof providerKey !== 'string' || payload.provider.enabled !== true)
    return new Set<string>();
  return new Set(
    payload.models.flatMap((model) =>
      isRecord(model) && model.enabled === true && typeof model.modelKey === 'string'
        ? [`${providerKey}:${model.modelKey}`]
        : [],
    ),
  );
};

export interface RemovedModelsCheck {
  forceDisabledDependents?: ForceDisabledDependents;
  removed: boolean;
}

export const groupEnabledReferencesByProvider = (
  references: ReadonlySet<string>,
): Map<string, string[]> => {
  const byProvider = new Map<string, string[]>();
  for (const reference of references) {
    const separator = reference.indexOf(':');
    const providerKey = reference.slice(0, separator);
    const modelKey = reference.slice(separator + 1);
    const modelKeys = byProvider.get(providerKey);
    if (modelKeys) {
      modelKeys.push(modelKey);
    } else {
      byProvider.set(providerKey, [modelKey]);
    }
  }
  return byProvider;
};

export const resolveBlockingDependents = async (
  tx: Transaction,
  references: ReadonlySet<string>,
  resolveDependentsForModels: typeof resolveAiCatalogDependentsForModels,
) => {
  const byProvider = groupEnabledReferencesByProvider(references);
  if (byProvider.size === 0) return [];
  const dependents = (
    await Promise.all(
      [...byProvider].map(([providerKey, modelKeys]) =>
        resolveDependentsForModels(tx, providerKey, modelKeys),
      ),
    )
  ).flat();
  return dependents.filter((item) => item.blocking);
};

export const assertRemovedModelsUnused = async (
  tx: Transaction,
  currentPayload: Record<string, unknown> | null,
  targetPayload: Record<string, unknown> | null,
  resolveDependentsForModels: typeof resolveAiCatalogDependentsForModels,
  options: { actorUserId: string; force: boolean; locks: ForceDisableLockSet },
): Promise<RemovedModelsCheck> => {
  const current = enabledModelReferences(currentPayload);
  const target = enabledModelReferences(targetPayload);
  const removed = new Set([...current].filter((reference) => !target.has(reference)));
  if (removed.size === 0) return { removed: false };
  const byProvider = groupEnabledReferencesByProvider(removed);
  const dependents = (
    await Promise.all(
      [...byProvider].map(([providerKey, modelKeys]) =>
        resolveDependentsForModels(tx, providerKey, modelKeys),
      ),
    )
  ).flat();
  const blocking = dependents.filter((item) => item.blocking);
  if (blocking.length === 0) return { removed: true };
  if (!options.force) {
    throw new AiCatalogResourceInUseError(dependents);
  }
  const unlockedAgent = blocking.some(
    (item) => item.resourceType === 'agent' && !options.locks.agentIds.has(item.resourceId),
  );
  const unlockedSettings =
    blocking.some((item) => item.resourceType === 'setting') && !options.locks.settingsBundle;
  if (unlockedAgent || unlockedSettings) {
    throw new PlatformRevisionConflictError('Published dependents changed during force-disable');
  }
  const removedByProvider = new Map(
    [...byProvider].map(([providerKey, modelKeys]) => [providerKey, new Set(modelKeys)]),
  );
  const forceDisabledDependents = await forceResolveAiCatalogDependents(
    tx,
    blocking,
    removedByProvider,
    options.actorUserId,
  );
  return { forceDisabledDependents, removed: true };
};
