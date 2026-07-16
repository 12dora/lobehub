import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminAiModelDependentsInput,
  AdminAiModelDependentsOutput,
  AdminAiModelListInput,
  AdminAiModelListOutput,
  AdminAiProviderGetInput,
  AdminAiProviderGetOutput,
  AdminAiProviderListInput,
  AdminAiProviderListOutput,
} from '../features/admin/ai/types';

/** Typed client boundary for the M07 platform AI catalog. */
class AdminAiCatalogService {
  getProvider = async (input: AdminAiProviderGetInput): Promise<AdminAiProviderGetOutput> =>
    lambdaClient.admin.aiProviders.get.query(input);

  getModelDependents = async (
    input: AdminAiModelDependentsInput,
  ): Promise<AdminAiModelDependentsOutput> => lambdaClient.admin.aiModels.dependents.query(input);

  listModels = async (input: AdminAiModelListInput): Promise<AdminAiModelListOutput> =>
    lambdaClient.admin.aiModels.list.query(input);

  listProviders = async (input: AdminAiProviderListInput): Promise<AdminAiProviderListOutput> =>
    lambdaClient.admin.aiProviders.list.query(input);
}

export const adminAiCatalogService = new AdminAiCatalogService();
