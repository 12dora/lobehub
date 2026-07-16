import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminSettingsGetDraftOutput,
  AdminSettingsPublishInput,
  AdminSettingsPublishOutput,
  AdminSettingsRollbackInput,
  AdminSettingsRollbackOutput,
  AdminSettingsSaveDraftInput,
  AdminSettingsSaveDraftOutput,
  AdminSettingsValidateDraftInput,
  AdminSettingsValidateDraftOutput,
} from '@/server/enterprise/contracts/adminSettings';

/**
 * Typed client wrappers for `admin.settings.*`.
 * Components must not call lambdaClient directly — use this service + SWR hooks.
 */
class AdminSettingsService {
  getDraft = async (): Promise<AdminSettingsGetDraftOutput> => {
    return lambdaClient.admin.settings.getDraft.query();
  };

  saveDraft = async (input: AdminSettingsSaveDraftInput): Promise<AdminSettingsSaveDraftOutput> => {
    return lambdaClient.admin.settings.saveDraft.mutate(input);
  };

  validateDraft = async (
    input: AdminSettingsValidateDraftInput = {},
  ): Promise<AdminSettingsValidateDraftOutput> => {
    return lambdaClient.admin.settings.validateDraft.mutate(input);
  };

  publish = async (input: AdminSettingsPublishInput): Promise<AdminSettingsPublishOutput> => {
    return lambdaClient.admin.settings.publish.mutate(input);
  };

  rollback = async (input: AdminSettingsRollbackInput): Promise<AdminSettingsRollbackOutput> => {
    return lambdaClient.admin.settings.rollback.mutate(input);
  };
}

export const adminSettingsService = new AdminSettingsService();
