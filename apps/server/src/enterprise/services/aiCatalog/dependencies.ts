import { isRecord } from '@lobechat/utils/object';
import { and, eq } from 'drizzle-orm';

import { platformAgents, platformSettingPolicies } from '@/database/schemas/platform';
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
      .where(
        and(
          eq(platformAgents.provider, providerKey),
          eq(platformAgents.model, modelKey),
          eq(platformAgents.status, 'published'),
        ),
      ),
    db
      .select({ path: platformSettingPolicies.path, value: platformSettingPolicies.value })
      .from(platformSettingPolicies)
      .where(eq(platformSettingPolicies.status, 'published')),
  ]);
  return [
    ...agents.map((agent) => ({
      blocking: true,
      label: agent.title,
      resourceId: agent.id,
      resourceType: 'agent',
    })),
    ...settings
      .filter((setting) => jsonContainsModelReference(setting.value, providerKey, modelKey))
      .map((setting) => ({
        blocking: true,
        label: setting.path,
        resourceId: setting.path,
        resourceType: 'setting',
      })),
  ];
};
