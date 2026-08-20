import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminAgentTemplateCreateInput,
  AdminAgentTemplateDeleteInput,
  AdminAgentTemplateDeleteOutput,
  AdminAgentTemplateImportInput,
  AdminAgentTemplateImportOutput,
  AdminAgentTemplateItem,
  AdminAgentTemplateListInput,
  AdminAgentTemplateListOutput,
  AdminAgentTemplateReorderInput,
  AdminAgentTemplateReorderOutput,
  AdminAgentTemplateSetEnabledInput,
  AdminAgentTemplateUpdateInput,
} from '@/server/enterprise/contracts/adminAgentTemplates';

/**
 * Typed client boundary for `admin.agentTemplates.*`.
 * Direct-save module — no reauth wrapper (the server does not gate these on recent reauth).
 */
class AdminAgentTemplatesService {
  create = async (input: AdminAgentTemplateCreateInput): Promise<AdminAgentTemplateItem> =>
    lambdaClient.admin.agentTemplates.create.mutate(input);

  delete = async (input: AdminAgentTemplateDeleteInput): Promise<AdminAgentTemplateDeleteOutput> =>
    lambdaClient.admin.agentTemplates.delete.mutate(input);

  importBuiltins = async (
    input: AdminAgentTemplateImportInput,
  ): Promise<AdminAgentTemplateImportOutput> =>
    lambdaClient.admin.agentTemplates.importBuiltins.mutate(input);

  list = async (input: AdminAgentTemplateListInput): Promise<AdminAgentTemplateListOutput> =>
    lambdaClient.admin.agentTemplates.list.query(input);

  reorder = async (
    input: AdminAgentTemplateReorderInput,
  ): Promise<AdminAgentTemplateReorderOutput> =>
    lambdaClient.admin.agentTemplates.reorder.mutate(input);

  setEnabled = async (input: AdminAgentTemplateSetEnabledInput): Promise<AdminAgentTemplateItem> =>
    lambdaClient.admin.agentTemplates.setEnabled.mutate(input);

  update = async (input: AdminAgentTemplateUpdateInput): Promise<AdminAgentTemplateItem> =>
    lambdaClient.admin.agentTemplates.update.mutate(input);
}

export const adminAgentTemplatesService = new AdminAgentTemplatesService();
