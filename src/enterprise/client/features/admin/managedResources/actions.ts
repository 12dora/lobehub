import debug from 'debug';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminManagedResourcesPublishInput,
  AdminManagedResourcesPublishOutput,
  AdminManagedResourcesSaveDraftInput,
  AdminManagedResourcesSaveDraftOutput,
} from '@/server/enterprise/contracts/adminManagedResources';

const log = debug('lobe-client:admin:managed-resources');

export const saveManagedResourceDraft = async (params: {
  input: AdminManagedResourcesSaveDraftInput;
  saveDraft: (
    input: AdminManagedResourcesSaveDraftInput,
  ) => Promise<AdminManagedResourcesSaveDraftOutput>;
}): Promise<AdminManagedResourcesSaveDraftOutput> => params.saveDraft(params.input);

export type PublishManagedResourcePolicyResult = {
  /** True when publish committed but capability refresh failed (best-effort). */
  capabilityRefreshFailed: boolean;
  output: AdminManagedResourcesPublishOutput;
};

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
}): Promise<PublishManagedResourcePolicyResult> => {
  // Freeze one verified CAS payload across the initial request and the post-reauth retry.
  const input = Object.freeze({ ...params.input });
  const runWithReauth = params.withReauthRetry ?? withAdminReauthRetry;
  // Commit boundary: publish success is authoritative. Capability refresh is best-effort
  // so a later refresh failure is not reported as a failed (already-committed) publish.
  const output = await runWithReauth(() => params.publish(input), {
    authMethod: params.authMethod,
  });
  try {
    await params.refreshCapabilities();
    return { capabilityRefreshFailed: false, output };
  } catch (error) {
    log('post-publish capability refresh failed: %O', error);
    return { capabilityRefreshFailed: true, output };
  }
};
