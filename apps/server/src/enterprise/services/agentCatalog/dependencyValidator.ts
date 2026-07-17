import type { PlatformAgentDependencySnapshot } from '@lobechat/types';
import { isRecord } from '@lobechat/utils/object';

import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { Transaction } from '@/database/type';

import {
  type PlatformAgentDependencyIssueCode,
  PlatformAgentDependencyValidationError,
} from './errors';

const isEnabledChatModel = (
  payload: Record<string, unknown>,
  providerKey: string,
  modelKey: string,
): boolean => {
  if (!isRecord(payload.provider) || !Array.isArray(payload.models)) return false;
  if (payload.provider.providerKey !== providerKey || payload.provider.enabled !== true)
    return false;
  return payload.models.some(
    (model) =>
      isRecord(model) &&
      model.modelKey === modelKey &&
      model.enabled === true &&
      (model.type === undefined || model.type === 'chat'),
  );
};

/** Exact M07/M08/M09 validation. Call only while holding the shared publication lock. */
export const assertExactPlatformAgentDependencies = async (
  tx: Transaction,
  snapshot: PlatformAgentDependencySnapshot,
): Promise<void> => {
  const issues: PlatformAgentDependencyIssueCode[] = [];

  const aiRepository = new PlatformAiCatalogRepository(tx);
  const provider = await aiRepository.getProviderByKey(snapshot.model.providerKey);
  const providerRevision = provider
    ? await aiRepository.getProviderRevision(provider.id, snapshot.model.providerRevision)
    : undefined;
  if (
    !provider ||
    provider.status !== 'published' ||
    !providerRevision ||
    providerRevision.status !== 'published' ||
    providerRevision.checksum !== snapshot.model.providerChecksum ||
    !isEnabledChatModel(
      providerRevision.payload,
      snapshot.model.providerKey,
      snapshot.model.modelKey,
    )
  ) {
    issues.push('AI_MODEL_UNAVAILABLE');
  }

  const skillRepository = new PlatformSkillCatalogRepository(tx);
  for (const reference of snapshot.skills) {
    const row = await skillRepository.resolveVersion(reference.skillKey, reference.version);
    if (!row || row.version.checksum !== reference.checksum) issues.push('SKILL_UNAVAILABLE');
  }

  const connectorRepository = new PlatformConnectorCatalogRepository(tx);
  for (const reference of snapshot.connectors) {
    const connector = await connectorRepository.getConnectorByKey(reference.connectorKey);
    const revision = connector
      ? await connectorRepository.getPublishedRuntimeRevision(
          connector.id,
          reference.publishedRevision,
        )
      : undefined;
    if (
      !connector ||
      connector.id !== reference.connectorId ||
      connector.status !== 'published' ||
      !revision ||
      revision.provenance.checksum !== reference.publishedChecksum ||
      revision.payload.connector.id !== reference.connectorId ||
      revision.payload.connector.key !== reference.connectorKey ||
      revision.payload.connector.enabled !== true
    ) {
      issues.push('CONNECTOR_UNAVAILABLE');
      continue;
    }
    const usableTools = new Set(
      revision.payload.tools
        .filter(({ platformPolicy }) => platformPolicy !== 'deny')
        .map(({ toolKey }) => toolKey),
    );
    if (reference.allowedToolKeys.some((toolKey) => !usableTools.has(toolKey))) {
      issues.push('CONNECTOR_TOOL_UNAVAILABLE');
    }
  }

  if (issues.length > 0) throw new PlatformAgentDependencyValidationError(issues);
};
