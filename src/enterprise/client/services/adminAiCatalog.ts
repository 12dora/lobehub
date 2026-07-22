import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminAiModelCreateInput,
  AdminAiModelCreateTargetListInput,
  AdminAiModelCreateTargetListOutput,
  AdminAiModelDeleteInput,
  AdminAiModelDeleteOutput,
  AdminAiModelDependentsInput,
  AdminAiModelDependentsOutput,
  AdminAiModelDraftContextInput,
  AdminAiModelDraftContextOutput,
  AdminAiModelListInput,
  AdminAiModelListOutput,
  AdminAiModelMutationOutput,
  AdminAiModelReorderInput,
  AdminAiModelReorderOutput,
  AdminAiModelUpdateInput,
  AdminAiProviderArchiveInput,
  AdminAiProviderCreateDraftInput,
  AdminAiProviderDeleteInput,
  AdminAiProviderDeleteOutput,
  AdminAiProviderGetInput,
  AdminAiProviderGetOutput,
  AdminAiProviderListInput,
  AdminAiProviderListOutput,
  AdminAiProviderMutationOutput,
  AdminAiProviderPublishInput,
  AdminAiProviderRevisionHistoryInput,
  AdminAiProviderRevisionHistoryOutput,
  AdminAiProviderRevisionOutput,
  AdminAiProviderRollbackInput,
  AdminAiProviderTestInput,
  AdminAiProviderUpdateDraftInput,
  AiConnectionTestResult,
} from '../features/admin/ai/types';

/** Typed client boundary for the M07 platform AI catalog. */
class AdminAiCatalogService {
  archiveProvider = async (
    input: AdminAiProviderArchiveInput,
  ): Promise<AdminAiProviderRevisionOutput> => lambdaClient.admin.aiProviders.archive.mutate(input);

  createModel = async (input: AdminAiModelCreateInput): Promise<AdminAiModelMutationOutput> =>
    lambdaClient.admin.aiModels.create.mutate(input);

  createProvider = async (
    input: AdminAiProviderCreateDraftInput,
  ): Promise<AdminAiProviderMutationOutput> =>
    lambdaClient.admin.aiProviders.createDraft.mutate(input);

  deleteModel = async (input: AdminAiModelDeleteInput): Promise<AdminAiModelDeleteOutput> =>
    lambdaClient.admin.aiModels.deleteFromDraft.mutate(input);

  deleteProvider = async (
    input: AdminAiProviderDeleteInput,
  ): Promise<AdminAiProviderDeleteOutput> => lambdaClient.admin.aiProviders.delete.mutate(input);

  getProvider = async (input: AdminAiProviderGetInput): Promise<AdminAiProviderGetOutput> =>
    lambdaClient.admin.aiProviders.get.query(input);

  getModelDependents = async (
    input: AdminAiModelDependentsInput,
  ): Promise<AdminAiModelDependentsOutput> => lambdaClient.admin.aiModels.dependents.query(input);

  getModelCreateDraftContext = async (
    input: AdminAiModelDraftContextInput,
  ): Promise<AdminAiModelDraftContextOutput> =>
    lambdaClient.admin.aiModels.getCreateDraftContext.query(input);

  getModelDeleteDraftContext = async (
    input: AdminAiModelDraftContextInput,
  ): Promise<AdminAiModelDraftContextOutput> =>
    lambdaClient.admin.aiModels.getDeleteDraftContext.query(input);

  getModelUpdateDraftContext = async (
    input: AdminAiModelDraftContextInput,
  ): Promise<AdminAiModelDraftContextOutput> =>
    lambdaClient.admin.aiModels.getUpdateDraftContext.query(input);

  listModels = async (input: AdminAiModelListInput): Promise<AdminAiModelListOutput> =>
    lambdaClient.admin.aiModels.list.query(input);

  listModelCreateTargets = async (
    input: AdminAiModelCreateTargetListInput,
  ): Promise<AdminAiModelCreateTargetListOutput> =>
    lambdaClient.admin.aiModels.listCreateTargets.query(input);

  listProviderRevisions = async (
    input: AdminAiProviderRevisionHistoryInput,
  ): Promise<AdminAiProviderRevisionHistoryOutput> =>
    lambdaClient.admin.aiProviders.listRevisions.query(input);

  listProviders = async (input: AdminAiProviderListInput): Promise<AdminAiProviderListOutput> =>
    lambdaClient.admin.aiProviders.list.query(input);

  publishProvider = async (
    input: AdminAiProviderPublishInput,
  ): Promise<AdminAiProviderRevisionOutput> => lambdaClient.admin.aiProviders.publish.mutate(input);

  reorderModels = async (input: AdminAiModelReorderInput): Promise<AdminAiModelReorderOutput> =>
    lambdaClient.admin.aiModels.reorder.mutate(input);

  rollbackProvider = async (
    input: AdminAiProviderRollbackInput,
  ): Promise<AdminAiProviderRevisionOutput> =>
    lambdaClient.admin.aiProviders.rollback.mutate(input);

  testProvider = async (input: AdminAiProviderTestInput): Promise<AiConnectionTestResult> =>
    lambdaClient.admin.aiProviders.test.mutate(input);

  updateModel = async (input: AdminAiModelUpdateInput): Promise<AdminAiModelMutationOutput> =>
    lambdaClient.admin.aiModels.update.mutate(input);

  updateProvider = async (
    input: AdminAiProviderUpdateDraftInput,
  ): Promise<AdminAiProviderMutationOutput> =>
    lambdaClient.admin.aiProviders.updateDraft.mutate(input);
}

export const adminAiCatalogService = new AdminAiCatalogService();
