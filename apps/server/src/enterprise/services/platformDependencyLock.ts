import { isRecord } from '@lobechat/utils/object';
import { sql } from 'drizzle-orm';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { Transaction } from '@/database/type';

const PLATFORM_DEPENDENCY_LOCK_NAMESPACE = 'aihub:platform-published-dependencies:v1';

/**
 * Shared protocol for publishing dependency references and checking destructive mutations.
 * Every future published resource that can reference another platform resource must acquire it.
 */
export const acquirePlatformDependencyPublicationLock = async (tx: Transaction): Promise<void> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${PLATFORM_DEPENDENCY_LOCK_NAMESPACE})::bigint)`,
  );
};

interface PlatformAiReference {
  modelKey: string;
  providerKey: string;
}

const collectNestedAiReferences = (value: unknown): PlatformAiReference[] => {
  if (Array.isArray(value)) return value.flatMap(collectNestedAiReferences);
  if (!isRecord(value)) return [];
  const own =
    typeof value.provider === 'string' && typeof value.model === 'string'
      ? [{ modelKey: value.model, providerKey: value.provider }]
      : [];
  return [...own, ...Object.values(value).flatMap(collectNestedAiReferences)];
};

const collectPathAiReferences = (value: unknown): PlatformAiReference[] => {
  if (!isRecord(value)) return [];
  const providers = new Map<string, string>();
  const models = new Map<string, string>();
  for (const [path, policy] of Object.entries(value)) {
    if (!isRecord(policy) || typeof policy.value !== 'string') continue;
    if (path.endsWith('.provider')) providers.set(path.slice(0, -'.provider'.length), policy.value);
    if (path.endsWith('.model')) models.set(path.slice(0, -'.model'.length), policy.value);
  }
  return [...providers].flatMap(([prefix, providerKey]) => {
    const modelKey = models.get(prefix);
    return modelKey ? [{ modelKey, providerKey }] : [];
  });
};

export class PlatformDependencyTargetNotPublishedError extends Error {
  readonly code = 'PLATFORM_CONFIG_VALIDATION_FAILED';

  constructor() {
    super('PLATFORM_CONFIG_VALIDATION_FAILED');
  }
}

/** Validate AI references while holding the shared dependency publication lock. */
export const assertPublishedPlatformAiReferences = async (
  tx: Transaction,
  value: unknown,
): Promise<void> => {
  const references = [...collectNestedAiReferences(value), ...collectPathAiReferences(value)];
  if (references.length === 0) return;
  const revisions = await new PlatformAiCatalogRepository(
    tx,
  ).listLatestPublishedProviderRevisions();
  const published = new Set(
    revisions.flatMap((revision) => {
      if (!isRecord(revision.payload.provider) || !Array.isArray(revision.payload.models))
        return [];
      const providerKey = revision.payload.provider.providerKey;
      if (typeof providerKey !== 'string' || revision.payload.provider.enabled !== true) return [];
      return revision.payload.models.flatMap((model) =>
        isRecord(model) && model.enabled === true && typeof model.modelKey === 'string'
          ? [`${providerKey}:${model.modelKey}`]
          : [],
      );
    }),
  );
  if (
    references.some(({ modelKey, providerKey }) => !published.has(`${providerKey}:${modelKey}`))
  ) {
    throw new PlatformDependencyTargetNotPublishedError();
  }
};
