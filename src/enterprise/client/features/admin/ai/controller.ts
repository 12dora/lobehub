import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type {
  AdminAiModelDependentsOutput,
  AdminAiProviderCreateDraftInput,
  AdminAiProviderDraft,
  AdminAiProviderUpdateDraftInput,
  AiSecretMutation,
} from './types';

export type AiCatalogSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

export interface AiCatalogPermissions {
  canArchiveProvider: boolean;
  canCreateModel: boolean;
  canCreateProvider: boolean;
  canDeleteModel: boolean;
  canPublishModel: boolean;
  canPublishProvider: boolean;
  canReadModels: boolean;
  canReadProviders: boolean;
  canReorderModels: boolean;
  canTestProvider: boolean;
  canUpdateModel: boolean;
  canUpdateProvider: boolean;
}

export const deriveAiCatalogPermissions = (
  permissions: readonly string[],
): AiCatalogPermissions => {
  const granted = new Set(permissions);
  return {
    canArchiveProvider: granted.has(PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE),
    canCreateModel: granted.has(PLATFORM_PERMISSIONS.AI_MODEL_CREATE),
    canCreateProvider: granted.has(PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE),
    canDeleteModel: granted.has(PLATFORM_PERMISSIONS.AI_MODEL_DELETE),
    canPublishModel: granted.has(PLATFORM_PERMISSIONS.AI_MODEL_PUBLISH),
    canPublishProvider: granted.has(PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH),
    canReadModels: granted.has(PLATFORM_PERMISSIONS.AI_MODEL_READ),
    canReadProviders: granted.has(PLATFORM_PERMISSIONS.AI_PROVIDER_READ),
    canReorderModels: granted.has(PLATFORM_PERMISSIONS.AI_MODEL_UPDATE),
    canTestProvider: granted.has(PLATFORM_PERMISSIONS.AI_PROVIDER_TEST),
    canUpdateModel: granted.has(PLATFORM_PERMISSIONS.AI_MODEL_UPDATE),
    canUpdateProvider: granted.has(PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE),
  };
};

export type AiProviderPrimaryAction = 'none' | 'publish' | 'retry' | 'save' | 'test';

/** Keep one dominant action in the sticky footer. */
export const resolveAiProviderPrimaryAction = (params: {
  canPublish: boolean;
  canSave: boolean;
  canTest: boolean;
  conflict: boolean;
  dirty: boolean;
  saveState: AiCatalogSaveState;
  testPassed: boolean;
}): AiProviderPrimaryAction => {
  if (params.conflict) return 'none';
  if (params.saveState === 'failed' && params.canSave) return 'retry';
  if (params.dirty && params.canSave) return 'save';
  if (params.canTest && !params.testPassed) return 'test';
  if (params.canPublish && params.testPassed) return 'publish';
  return 'none';
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};

/** Secret state is metadata only and deliberately excluded from editor fingerprints. */
export const fingerprintAiProviderPublicDraft = (draft: AdminAiProviderDraft): string =>
  JSON.stringify(
    canonicalize({
      checkModel: draft.checkModel,
      config: draft.config,
      description: draft.description,
      displayName: draft.displayName,
      enabled: draft.enabled,
      fetchOnClient: draft.fetchOnClient,
      logo: draft.logo,
      providerKey: draft.providerKey,
      settings: draft.settings,
      sort: draft.sort,
    }),
  );

export type EditableAiProviderDraft = Pick<
  AdminAiProviderDraft,
  | 'checkModel'
  | 'config'
  | 'description'
  | 'displayName'
  | 'enabled'
  | 'fetchOnClient'
  | 'logo'
  | 'settings'
  | 'sort'
>;

export const toEditableAiProviderDraft = (
  draft: AdminAiProviderDraft,
): EditableAiProviderDraft => ({
  checkModel: draft.checkModel,
  config: structuredClone(draft.config),
  description: draft.description,
  displayName: draft.displayName,
  enabled: draft.enabled,
  fetchOnClient: draft.fetchOnClient,
  logo: draft.logo,
  settings: structuredClone(draft.settings),
  sort: draft.sort,
});

export const buildProviderUpdatePayload = (params: {
  draft: EditableAiProviderDraft;
  draftToken: string;
  id: string;
  reason: string;
  revision: number;
}): AdminAiProviderUpdateDraftInput => ({
  ...structuredClone(params.draft),
  expectedDraftToken: params.draftToken,
  expectedRevision: params.revision,
  id: params.id,
  reason: params.reason.trim(),
  secret: { operation: 'keep' },
});

export const hasBlockingModelDependents = (dependents: AdminAiModelDependentsOutput): boolean =>
  dependents.items.some((item) => item.blocking);

/** Reorder is safe only when the UI owns the complete provider draft model set. */
export const buildCompleteModelOrder = (
  completeIds: readonly string[],
  requestedIds: readonly string[],
): { id: string; sort: number }[] | null => {
  if (completeIds.length === 0 || completeIds.length !== requestedIds.length) return null;
  const complete = new Set(completeIds);
  const requested = new Set(requestedIds);
  if (complete.size !== completeIds.length || requested.size !== requestedIds.length) return null;
  if ([...complete].some((id) => !requested.has(id))) return null;
  return requestedIds.map((id, sort) => ({ id, sort }));
};

export const parseJsonObject = (
  value: string,
): { error: string | null; value: Record<string, unknown> | null } => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'object', value: null };
    }
    return { error: null, value: parsed as Record<string, unknown> };
  } catch {
    return { error: 'syntax', value: null };
  }
};

export const parseNullableJsonObject = (
  value: string,
): { error: string | null; value: Record<string, unknown> | null } => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null) return { error: null, value: null };
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'object', value: null };
    }
    return { error: null, value: parsed as Record<string, unknown> };
  } catch {
    return { error: 'syntax', value: null };
  }
};

export const buildAiSecretMutation = (
  operation: AiSecretMutation['operation'],
  value: string,
): AiSecretMutation | null => {
  if (operation === 'replace') {
    return value ? { operation, value } : null;
  }
  return { operation };
};

export const buildProviderCreatePayload = (params: {
  config: Record<string, unknown>;
  description: string;
  displayName: string;
  enabled: boolean;
  fetchOnClient: boolean;
  providerKey: string;
  reason: string;
  secretValue: string;
  settings: Record<string, unknown>;
  source: string;
}): AdminAiProviderCreateDraftInput => ({
  config: structuredClone(params.config),
  description: params.description.trim() || null,
  displayName: params.displayName.trim(),
  enabled: params.enabled,
  fetchOnClient: params.fetchOnClient,
  providerKey: params.providerKey.trim(),
  reason: params.reason.trim(),
  ...(params.secretValue
    ? { secret: { operation: 'replace' as const, value: params.secretValue } }
    : {}),
  settings: structuredClone(params.settings),
  source: params.source.trim() || 'custom',
});
