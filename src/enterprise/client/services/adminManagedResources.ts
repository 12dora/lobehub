import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminManagedResourcesGetOutput,
  AdminManagedResourcesSaveInput,
  AdminManagedResourcesSaveOutput,
} from '@/server/enterprise/contracts/adminManagedResources';

/** Typed client boundary for `admin.managedResources.*`. */
class AdminManagedResourcesService {
  get = async (): Promise<AdminManagedResourcesGetOutput> => {
    return lambdaClient.admin.managedResources.get.query();
  };

  /**
   * Apply the managed-resource policy site-wide in one transaction (no draft step).
   * Dangerous mutation: wrap the call in `withAdminReauthRetry`.
   */
  save = async (
    input: AdminManagedResourcesSaveInput,
  ): Promise<AdminManagedResourcesSaveOutput> => {
    return lambdaClient.admin.managedResources.save.mutate(input);
  };
}

export const adminManagedResourcesService = new AdminManagedResourcesService();
