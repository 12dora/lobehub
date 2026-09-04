import { DEFAULT_AGENT_CONFIG, DEFAULT_INBOX_AVATAR, DEFAULT_INBOX_TITLE } from '@lobechat/const';
import type {
  PlatformAgentAssignmentMode,
  PlatformAgentDependencySnapshot,
  PlatformAgentModelParameters,
  PlatformAgentVersionConfig,
  PlatformAgentVersionPolicy,
} from '@lobechat/types';
import {
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
} from '@lobechat/types';
import { merge } from '@lobechat/utils';
import { isRecord } from '@lobechat/utils/object';
import type { LLMParams } from 'model-bank';

import type { PlatformAgentAssignmentSafeItem } from '@/database/repositories/platformAgentCatalog';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { PlatformAgentItem } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { getServerDefaultAgentConfig } from '@/server/globalConfig';

import {
  platformAgentDependencySnapshotSchema,
  platformAgentVersionConfigSchema,
} from '../../contracts/platformAgents/common';
import { resolveServerRuntimeBranding } from '../branding/runtimeBranding';
import { PlatformAgentDependencyValidationError, PlatformAgentInvalidInputError } from './errors';

/** Catalog identity key for the provisioned default-inbox Agent (matches the system key). */
export const PLATFORM_DEFAULT_INBOX_AGENT_KEY = PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY;

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

const mapLegacyModelParameters = (params: LLMParams | undefined): PlatformAgentModelParameters => {
  if (!params) return {};
  const mapped: PlatformAgentModelParameters = {};
  if (typeof params.frequency_penalty === 'number') {
    mapped.frequencyPenalty = params.frequency_penalty;
  }
  if (typeof params.max_tokens === 'number') mapped.maxTokens = params.max_tokens;
  if (typeof params.presence_penalty === 'number') {
    mapped.presencePenalty = params.presence_penalty;
  }
  if (typeof params.temperature === 'number') mapped.temperature = params.temperature;
  if (typeof params.top_p === 'number') mapped.topP = params.top_p;
  return mapped;
};

const nullableText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed || null;
};

/**
 * Global assignment that makes `default-inbox` eligible for runtime overlay: enabled + active
 * + global target. Mode `default` is sufficient for effective resolution (mandatory is not
 * required; the inbox is already excluded from the user catalog list).
 */
export const DEFAULT_INBOX_GLOBAL_ASSIGNMENT = {
  enabled: true,
  mode: 'default' as PlatformAgentAssignmentMode,
  pinnedVersionId: null,
  targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
  targetType: 'global' as const,
  versionPolicy: 'latest_published' as PlatformAgentVersionPolicy,
};

export const isDefaultInboxIdentity = (
  identity: Pick<PlatformAgentItem, 'isDefault' | 'systemKey'>,
): boolean => identity.isDefault || identity.systemKey === PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY;

export const isDefaultInboxGlobalAssignment = (
  assignment: Pick<PlatformAgentAssignmentSafeItem, 'targetId' | 'targetType'>,
): boolean =>
  assignment.targetType === 'global' && assignment.targetId === PLATFORM_AGENT_GLOBAL_TARGET_ID;

export const isEffectiveDefaultInboxGlobalAssignment = (
  assignment: Pick<
    PlatformAgentAssignmentSafeItem,
    'enabled' | 'pinnedVersionId' | 'status' | 'targetId' | 'targetType' | 'versionPolicy'
  >,
): boolean =>
  isDefaultInboxGlobalAssignment(assignment) &&
  assignment.enabled &&
  assignment.status === 'active' &&
  assignment.versionPolicy === 'latest_published' &&
  assignment.pinnedVersionId === null;

export interface DefaultInboxSeed {
  config: PlatformAgentVersionConfig;
  dependencySnapshot: PlatformAgentDependencySnapshot;
}

export interface BuildDefaultInboxSeedOptions {
  getServerDefaultAgentConfig?: typeof getServerDefaultAgentConfig;
  /**
   * Operator UI language from the admin mutation. Bundled `chat.inbox.title` currently
   * matches `DEFAULT_INBOX_TITLE` for every locale, so the fallback is locale-invariant.
   */
  locale?: string;
  resolveBranding?: typeof resolveServerRuntimeBranding;
}

/** Built-in inbox title for an operator locale. Locale tags are accepted but currently identical. */
const builtinInboxTitleFor = (_locale?: string) => DEFAULT_INBOX_TITLE;

/**
 * Seed the first published default-inbox version from the current legacy defaults:
 * `DEFAULT_AGENT_CONFIG` merged with the server env `DEFAULT_AGENT_CONFIG`, plus published
 * branding / builtin inbox title and avatar. Model/provider are pinned to the published AI
 * catalog revision so exact-dependency validation can succeed.
 */
export const buildDefaultInboxSeed = async (
  db: LobeChatDatabase | Transaction,
  options: BuildDefaultInboxSeedOptions = {},
): Promise<DefaultInboxSeed> => {
  const merged = merge(
    DEFAULT_AGENT_CONFIG,
    (options.getServerDefaultAgentConfig ?? getServerDefaultAgentConfig)(),
  );
  const branding = await (options.resolveBranding ?? resolveServerRuntimeBranding)({
    getDatabase: async () => db as LobeChatDatabase,
  });
  // Same fallback chain as `resolveDefaultInboxDisplayName`: published branding, else the
  // builtin inbox title (`DEFAULT_INBOX_TITLE` / chat `inbox.title`).
  const displayName =
    branding.defaultAgentDisplayName?.trim() || builtinInboxTitleFor(options.locale);
  // Published brand icon, else published logo, else the builtin inbox avatar. Unset
  // `publishedRevision` means no brand is live, so skip resolved fallback logos.
  const avatar =
    (branding.publishedRevision
      ? branding.iconUrl?.trim() || branding.logoUrl?.trim()
      : undefined) || DEFAULT_INBOX_AVATAR;
  // Preserve the effective legacy value, including an empty prompt. Do not substitute a
  // canned "helpful assistant" role — that would change inbox behaviour on first provision.
  const systemRole = merged.systemRole?.trim() ?? '';
  const openingQuestions = (merged.openingQuestions ?? []).filter(
    (question) => question.trim().length > 0,
  );

  const providerKey = merged.provider || DEFAULT_AGENT_CONFIG.provider;
  const modelKey = merged.model || DEFAULT_AGENT_CONFIG.model;
  if (!providerKey || !modelKey) {
    throw new PlatformAgentDependencyValidationError(['AI_MODEL_UNAVAILABLE']);
  }
  const aiRepository = new PlatformAiCatalogRepository(db);
  const provider = await aiRepository.getProviderByKey(providerKey);
  const revision = provider
    ? await aiRepository.getLatestPublishedProviderRevision(provider.id)
    : undefined;
  const payload = revision && isRecord(revision.payload) ? revision.payload : undefined;
  if (
    !provider ||
    provider.status !== 'published' ||
    !revision ||
    revision.status !== 'published' ||
    !payload ||
    !isEnabledChatModel(payload, providerKey, modelKey)
  ) {
    throw new PlatformAgentDependencyValidationError(['AI_MODEL_UNAVAILABLE']);
  }

  const configParsed = platformAgentVersionConfigSchema.safeParse({
    avatar,
    backgroundColor: null,
    description: null,
    displayName,
    modelParameters: mapLegacyModelParameters(merged.params),
    openingMessage: nullableText(merged.openingMessage),
    openingQuestions,
    systemRole,
    tags: [],
  });
  if (!configParsed.success) {
    throw new PlatformAgentInvalidInputError(
      'Default-inbox seed failed platformAgentVersionConfigSchema validation',
    );
  }
  const dependencyParsed = platformAgentDependencySnapshotSchema.safeParse({
    connectors: [],
    model: {
      modelKey,
      providerChecksum: revision.checksum,
      providerKey,
      providerRevision: revision.revision,
    },
    skills: [],
  });
  if (!dependencyParsed.success) {
    throw new PlatformAgentInvalidInputError(
      'Default-inbox seed failed platformAgentDependencySnapshotSchema validation',
    );
  }

  return {
    config: configParsed.data,
    dependencySnapshot: dependencyParsed.data,
  };
};
