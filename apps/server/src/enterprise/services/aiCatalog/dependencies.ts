import { isRecord } from '@lobechat/utils/object';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  platformAgents,
  platformAgentVersions,
  platformSettingPolicies,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AiCatalogDependent } from './errors';

const jsonContainsModelReference = (
  value: unknown,
  providerKey: string,
  modelKey: string,
): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsModelReference(item, providerKey, modelKey));
  }
  if (!isRecord(value)) return false;
  if (value.provider === providerKey && value.model === modelKey) return true;
  return Object.values(value).some((item) =>
    jsonContainsModelReference(item, providerKey, modelKey),
  );
};

const jsonContainsAnyModelReference = (
  value: unknown,
  providerKey: string,
  modelKeys: ReadonlySet<string>,
): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsAnyModelReference(item, providerKey, modelKeys));
  }
  if (!isRecord(value)) return false;
  if (
    value.provider === providerKey &&
    typeof value.model === 'string' &&
    modelKeys.has(value.model)
  ) {
    return true;
  }
  return Object.values(value).some((item) =>
    jsonContainsAnyModelReference(item, providerKey, modelKeys),
  );
};

export const resolveAiCatalogDependents = async (
  db: LobeChatDatabase | Transaction,
  providerKey: string,
  modelKey: string,
): Promise<AiCatalogDependent[]> =>
  resolveAiCatalogDependentsForModels(db, providerKey, [modelKey]);

/**
 * Batch dependency resolution for every model under a provider (hard-delete path).
 * One agents query + one settings scan instead of N+1 per model.
 */
export const resolveAiCatalogDependentsForModels = async (
  db: LobeChatDatabase | Transaction,
  providerKey: string,
  modelKeys: readonly string[],
): Promise<AiCatalogDependent[]> => {
  if (modelKeys.length === 0) return [];
  const modelKeySet = new Set(modelKeys);

  const [agents, settings] = await Promise.all([
    db
      .select({ id: platformAgents.id, title: platformAgents.title })
      .from(platformAgents)
      .innerJoin(
        platformAgentVersions,
        and(
          eq(platformAgentVersions.agentId, platformAgents.id),
          eq(platformAgentVersions.id, platformAgents.currentVersionId),
        ),
      )
      .where(
        and(
          eq(platformAgents.status, 'published'),
          eq(platformAgents.migrationRequired, false),
          sql`${platformAgentVersions.dependencySnapshot}->'model'->>'providerKey' = ${providerKey}`,
          inArray(sql`${platformAgentVersions.dependencySnapshot}->'model'->>'modelKey'`, [
            ...modelKeySet,
          ]),
        ),
      ),
    db
      .select({ path: platformSettingPolicies.path, value: platformSettingPolicies.value })
      .from(platformSettingPolicies)
      .where(eq(platformSettingPolicies.status, 'published')),
  ]);

  const pathValues = new Map(settings.map((setting) => [setting.path, setting.value]));
  const pairedSettingPaths = settings.flatMap((setting) => {
    if (!setting.path.endsWith('.provider') || setting.value !== providerKey) return [];
    const prefix = setting.path.slice(0, -'.provider'.length);
    const modelValue = pathValues.get(`${prefix}.model`);
    return typeof modelValue === 'string' && modelKeySet.has(modelValue) ? [prefix] : [];
  });
  const nestedSettingPaths = settings
    .filter((setting) => jsonContainsAnyModelReference(setting.value, providerKey, modelKeySet))
    .map((setting) => setting.path);
  const dependentSettingPaths = [...new Set([...nestedSettingPaths, ...pairedSettingPaths])];

  return [
    ...agents.map((agent) => ({
      blocking: true,
      label: agent.title,
      resourceId: agent.id,
      resourceType: 'agent',
    })),
    ...dependentSettingPaths.map((path) => ({
      blocking: true,
      label: path,
      resourceId: path,
      resourceType: 'setting',
    })),
  ];
};
