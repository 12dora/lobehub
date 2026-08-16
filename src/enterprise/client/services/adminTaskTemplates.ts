import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminTaskTemplateCreateInput,
  AdminTaskTemplateDeleteInput,
  AdminTaskTemplateDeleteOutput,
  AdminTaskTemplateImportInput,
  AdminTaskTemplateImportOutput,
  AdminTaskTemplateItem,
  AdminTaskTemplateListInput,
  AdminTaskTemplateListOutput,
  AdminTaskTemplateSetEnabledInput,
  AdminTaskTemplateUpdateInput,
} from '@/server/enterprise/contracts/adminTaskTemplates';

/**
 * Typed client boundary for `admin.taskTemplates.*`.
 * Direct-save module — no reauth wrapper (the server does not gate these on recent reauth).
 */
class AdminTaskTemplatesService {
  create = async (input: AdminTaskTemplateCreateInput): Promise<AdminTaskTemplateItem> =>
    lambdaClient.admin.taskTemplates.create.mutate(input);

  delete = async (input: AdminTaskTemplateDeleteInput): Promise<AdminTaskTemplateDeleteOutput> =>
    lambdaClient.admin.taskTemplates.delete.mutate(input);

  importRecommendations = async (
    input: AdminTaskTemplateImportInput,
  ): Promise<AdminTaskTemplateImportOutput> =>
    lambdaClient.admin.taskTemplates.importRecommendations.mutate(input);

  list = async (input: AdminTaskTemplateListInput): Promise<AdminTaskTemplateListOutput> =>
    lambdaClient.admin.taskTemplates.list.query(input);

  setEnabled = async (input: AdminTaskTemplateSetEnabledInput): Promise<AdminTaskTemplateItem> =>
    lambdaClient.admin.taskTemplates.setEnabled.mutate(input);

  update = async (input: AdminTaskTemplateUpdateInput): Promise<AdminTaskTemplateItem> =>
    lambdaClient.admin.taskTemplates.update.mutate(input);
}

export const adminTaskTemplatesService = new AdminTaskTemplatesService();
