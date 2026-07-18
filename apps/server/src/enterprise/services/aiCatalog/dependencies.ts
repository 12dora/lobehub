import { isRecord } from '@lobechat/utils/object';
import { and, eq, sql } from 'drizzle-orm';

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

export const resolveAiCatalogDependents = async (
  db: LobeChatDatabase | Transaction,
  providerKey: string,
  modelKey: string,
): Promise<AiCatalogDependent[]> => {
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
          sql`${platformAgentVersions.dependencySnapshot}->'model'->>'modelKey' = ${modelKey}`,
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
    return pathValues.get(`${prefix}.model`) === modelKey ? [prefix] : [];
  });
  const nestedSettingPaths = settings
    .filter((setting) => jsonContainsModelReference(setting.value, providerKey, modelKey))
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
