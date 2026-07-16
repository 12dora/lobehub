import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminManagedResourcesGetOutput,
  AdminManagedResourcesPublishInput,
  AdminManagedResourcesPublishOutput,
  AdminManagedResourcesSaveDraftInput,
  AdminManagedResourcesSaveDraftOutput,
} from '@/server/enterprise/contracts/adminManagedResources';

/** Typed client boundary for `admin.managedResources.*`. */
class AdminManagedResourcesService {
  get = async (): Promise<AdminManagedResourcesGetOutput> => {
    return lambdaClient.admin.managedResources.get.query();
  };

  publish = async (
    input: AdminManagedResourcesPublishInput,
  ): Promise<AdminManagedResourcesPublishOutput> => {
    return lambdaClient.admin.managedResources.publish.mutate(input);
  };

  saveDraft = async (
    input: AdminManagedResourcesSaveDraftInput,
  ): Promise<AdminManagedResourcesSaveDraftOutput> => {
    return lambdaClient.admin.managedResources.saveDraft.mutate(input);
  };
}

export const adminManagedResourcesService = new AdminManagedResourcesService();
