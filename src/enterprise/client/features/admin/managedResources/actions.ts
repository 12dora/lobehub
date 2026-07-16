import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminManagedResourcesPublishInput,
  AdminManagedResourcesPublishOutput,
  AdminManagedResourcesSaveDraftInput,
  AdminManagedResourcesSaveDraftOutput,
} from '@/server/enterprise/contracts/adminManagedResources';

export const saveManagedResourceDraft = async (params: {
  input: AdminManagedResourcesSaveDraftInput;
  saveDraft: (
    input: AdminManagedResourcesSaveDraftInput,
  ) => Promise<AdminManagedResourcesSaveDraftOutput>;
}): Promise<AdminManagedResourcesSaveDraftOutput> => params.saveDraft(params.input);

export const publishManagedResourcePolicy = async (params: {
  authMethod: AdminReauthAuthMethod;
  input: AdminManagedResourcesPublishInput;
  publish: (
    input: AdminManagedResourcesPublishInput,
  ) => Promise<AdminManagedResourcesPublishOutput>;
  refreshCapabilities: () => Promise<void>;
  withReauthRetry?: (
    fn: () => Promise<AdminManagedResourcesPublishOutput>,
    options?: Parameters<typeof withAdminReauthRetry>[1],
  ) => Promise<AdminManagedResourcesPublishOutput>;
}): Promise<AdminManagedResourcesPublishOutput> => {
  // Freeze one verified CAS payload across the initial request and the post-reauth retry.
  const input = Object.freeze({ ...params.input });
  const runWithReauth = params.withReauthRetry ?? withAdminReauthRetry;
  const result = await runWithReauth(() => params.publish(input), {
    authMethod: params.authMethod,
  });
  await params.refreshCapabilities();
  return result;
};
