import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminAuthSettingsGetOutput,
  AdminAuthSettingsUpdateInput,
  AdminAuthSettingsUpdateOutput,
} from '@/server/enterprise/contracts/adminAuthSettings';

/** Typed client boundary for `admin.authSettings.*`. */
class AdminAuthSettingsService {
  get = async (): Promise<AdminAuthSettingsGetOutput> => {
    return lambdaClient.admin.authSettings.get.query();
  };

  update = async (input: AdminAuthSettingsUpdateInput): Promise<AdminAuthSettingsUpdateOutput> => {
    return lambdaClient.admin.authSettings.update.mutate(input);
  };
}

export const adminAuthSettingsService = new AdminAuthSettingsService();
