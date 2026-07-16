import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type {
  AdminAiModelDependentsOutput,
  AdminAiProviderCreateDraftInput,
  AdminAiProviderDraft,
  AdminAiProviderUpdateDraftInput,
  AiConnectionTestState,
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

export const deriveGlobalModelActions = (permissions: AiCatalogPermissions) => ({
  canCreate: permissions.canCreateModel,
  canDelete: permissions.canDeleteModel && permissions.canReadModels,
  canEdit: permissions.canUpdateModel && permissions.canReadModels,
  canReorder: permissions.canReorderModels && permissions.canReadModels,
});

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

export interface AiProviderConnectionTestView {
  canPublish: boolean;
  stale: boolean;
  state: AiConnectionTestState | null;
}

/** Publish eligibility is derived only from a persisted test bound to the current draft. */
export const deriveAiProviderConnectionTestView = (params: {
  baseRevision: number;
  draftToken: string;
  locallyStale: boolean;
  state: AiConnectionTestState | null;
}): AiProviderConnectionTestView => {
  if (!params.state) return { canPublish: false, stale: params.locallyStale, state: null };
  const stale =
    params.locallyStale ||
    params.state.stale ||
    params.state.testedDraftToken !== params.draftToken ||
    params.state.testedRevision !== params.baseRevision;
  return {
    canPublish: params.state.status === 'success' && !stale,
    stale,
    state: params.state,
  };
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

type EditableAiProviderScalarDraft = Pick<
  AdminAiProviderDraft,
  'checkModel' | 'description' | 'displayName' | 'enabled' | 'fetchOnClient' | 'logo' | 'sort'
>;

/** Public editor state keeps raw JSON so invalid in-progress input is never lost. */
export interface EditableAiProviderDraft extends EditableAiProviderScalarDraft {
  configText: string;
  settingsText: string;
}

export type AiProviderJsonField = 'configText' | 'settingsText';

export interface AiProviderRebaseConflict {
  field: keyof EditableAiProviderDraft;
  latest: EditableAiProviderDraft[keyof EditableAiProviderDraft];
  local: EditableAiProviderDraft[keyof EditableAiProviderDraft];
}

export const toEditableAiProviderDraft = (
  draft: AdminAiProviderDraft,
): EditableAiProviderDraft => ({
  checkModel: draft.checkModel,
  configText: JSON.stringify(draft.config, null, 2),
  description: draft.description,
  displayName: draft.displayName,
  enabled: draft.enabled,
  fetchOnClient: draft.fetchOnClient,
  logo: draft.logo,
  settingsText: JSON.stringify(draft.settings, null, 2),
  sort: draft.sort,
});

export const validateEditableAiProviderDraft = (
  draft: EditableAiProviderDraft,
): {
  config: ReturnType<typeof parseJsonObject>;
  settings: ReturnType<typeof parseJsonObject>;
  valid: boolean;
} => {
  const config = parseJsonObject(draft.configText);
  const settings = parseJsonObject(draft.settingsText);
  return { config, settings, valid: !config.error && !settings.error };
};

export const buildProviderUpdatePayload = (params: {
  draft: EditableAiProviderDraft;
  draftToken: string;
  id: string;
  reason: string;
  revision: number;
}): AdminAiProviderUpdateDraftInput | null => {
  const { config, settings, valid } = validateEditableAiProviderDraft(params.draft);
  if (!valid || !config.value || !settings.value) return null;
  const { configText: _configText, settingsText: _settingsText, ...fields } = params.draft;
  return {
    ...structuredClone(fields),
    config: config.value,
    expectedDraftToken: params.draftToken,
    expectedRevision: params.revision,
    id: params.id,
    reason: params.reason.trim(),
    secret: { operation: 'keep' },
    settings: settings.value,
  };
};

const EDITABLE_PROVIDER_FIELDS = [
  'checkModel',
  'configText',
  'description',
  'displayName',
  'enabled',
  'fetchOnClient',
  'logo',
  'settingsText',
  'sort',
] as const satisfies readonly (keyof EditableAiProviderDraft)[];

/** Field-level three-way merge; divergent edits remain explicit and default to local. */
export const rebaseAiProviderDraft = (params: {
  latest: EditableAiProviderDraft;
  local: EditableAiProviderDraft;
  original: EditableAiProviderDraft;
}): { conflicts: AiProviderRebaseConflict[]; draft: EditableAiProviderDraft } => {
  const draft = structuredClone(params.latest);
  const conflicts: AiProviderRebaseConflict[] = [];
  for (const field of EDITABLE_PROVIDER_FIELDS) {
    const original = params.original[field];
    const local = params.local[field];
    const latest = params.latest[field];
    const localChanged = !Object.is(local, original);
    const latestChanged = !Object.is(latest, original);
    if (localChanged) {
      (draft[field] as unknown) = structuredClone(local);
    }
    if (localChanged && latestChanged && !Object.is(local, latest)) {
      conflicts.push({ field, latest: structuredClone(latest), local: structuredClone(local) });
    }
  }
  return { conflicts, draft };
};

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
