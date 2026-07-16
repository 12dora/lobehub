import type { AdminAiModelListInput, AdminAiProviderListInput } from './types';

export const ADMIN_AI_PROVIDER_LIST_KEY = 'admin.aiProviders.list' as const;
export const ADMIN_AI_PROVIDER_GET_KEY = 'admin.aiProviders.get' as const;
export const ADMIN_AI_MODEL_DEPENDENTS_KEY = 'admin.aiModels.dependents' as const;
export const ADMIN_AI_MODEL_LIST_KEY = 'admin.aiModels.list' as const;

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

export const buildAdminAiModelDependentsKey = (providerId: string, id: string) =>
  [ADMIN_AI_MODEL_DEPENDENTS_KEY, providerId, id] as const;

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
