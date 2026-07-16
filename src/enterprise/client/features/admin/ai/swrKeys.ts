import type { AdminAiProviderListInput } from './types';

export const ADMIN_AI_PROVIDER_LIST_KEY = 'admin.aiProviders.list' as const;
export const ADMIN_AI_PROVIDER_GET_KEY = 'admin.aiProviders.get' as const;
export const ADMIN_AI_MODEL_DEPENDENTS_KEY = 'admin.aiModels.dependents' as const;

export const buildAdminAiProviderListKey = (input: AdminAiProviderListInput) =>
  [ADMIN_AI_PROVIDER_LIST_KEY, input.cursor ?? '', input.limit, input.status ?? ''] as const;

export const buildAdminAiProviderGetKey = (id: string) => [ADMIN_AI_PROVIDER_GET_KEY, id] as const;

export const buildAdminAiModelDependentsKey = (providerId: string, id: string) =>
  [ADMIN_AI_MODEL_DEPENDENTS_KEY, providerId, id] as const;
