import type { AdminAiModelListInput, AdminAiProviderListInput } from './types';

export const ADMIN_AI_PROVIDER_LIST_KEY = 'admin.aiProviders.list' as const;
export const ADMIN_AI_PROVIDER_GET_KEY = 'admin.aiProviders.get' as const;
export const ADMIN_AI_MODEL_LIST_KEY = 'admin.aiModels.list' as const;
export const ADMIN_AI_PROVIDER_REVISIONS_KEY = 'admin.aiProviders.listRevisions' as const;

export const buildAdminAiProviderListKey = (input: AdminAiProviderListInput) =>
  [
    ADMIN_AI_PROVIDER_LIST_KEY,
    input.cursor ?? '',
    input.enabled ?? '',
    input.limit,
    input.query ?? '',
    input.source ?? '',
    input.status ?? '',
  ] as const;

export const buildAdminAiProviderGetKey = (id: string) => [ADMIN_AI_PROVIDER_GET_KEY, id] as const;

export const buildAdminAiModelListKey = (input: AdminAiModelListInput) =>
  [
    ADMIN_AI_MODEL_LIST_KEY,
    input.cursor ?? '',
    input.enabled ?? '',
    input.limit,
    input.provider ?? '',
    input.query ?? '',
    input.status ?? '',
    input.type ?? '',
  ] as const;

export const buildAdminAiProviderRevisionsKey = (id: string, beforeRevision?: number, limit = 50) =>
  [ADMIN_AI_PROVIDER_REVISIONS_KEY, id, beforeRevision ?? '', limit] as const;
