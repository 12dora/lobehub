import debug from 'debug';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminManagedResourcesSaveInput,
  AdminManagedResourcesSaveOutput,
} from '@/server/enterprise/contracts/adminManagedResources';

const log = debug('lobe-client:admin:managed-resources');

export type SaveManagedResourcePolicyResult = {
  /** True when the policy committed but the capability refresh failed (best-effort). */
  capabilityRefreshFailed: boolean;
  output: AdminManagedResourcesSaveOutput;
};

/**
 * Apply the managed-resource policy site-wide (write + publish in one server transaction),
 * then refresh platform capabilities so the current session reflects the new policy.
 */
export const saveManagedResourcePolicy = async (params: {
  authMethod: AdminReauthAuthMethod;
  input: AdminManagedResourcesSaveInput;
  /**
   * Invoked at the commit boundary — after the policy is applied site-wide, before any
   * best-effort refresh. User-facing success belongs here so a later refresh failure
   * cannot swallow or delay it.
   */
  onCommitted?: (output: AdminManagedResourcesSaveOutput) => void;
  refreshCapabilities: () => Promise<void>;
  save: (input: AdminManagedResourcesSaveInput) => Promise<AdminManagedResourcesSaveOutput>;
  withReauthRetry?: (
    fn: () => Promise<AdminManagedResourcesSaveOutput>,
    options?: Parameters<typeof withAdminReauthRetry>[1],
  ) => Promise<AdminManagedResourcesSaveOutput>;
}): Promise<SaveManagedResourcePolicyResult> => {
  // Freeze one verified CAS payload across the initial request and the post-reauth retry.
  const input = Object.freeze({ ...params.input });
  const runWithReauth = params.withReauthRetry ?? withAdminReauthRetry;
  // Commit boundary: save success is authoritative. Capability refresh is best-effort so a
  // later refresh failure is not reported as a failed (already-committed) write.
  const output = await runWithReauth(() => params.save(input), {
    authMethod: params.authMethod,
  });
  try {
    params.onCommitted?.(output);
  } catch (error) {
    // Never let a notification fault turn an applied policy into a failed save.
    log('commit-boundary notification failed: %O', error);
  }
  try {
    await params.refreshCapabilities();
    return { capabilityRefreshFailed: false, output };
  } catch (error) {
    log('post-save capability refresh failed: %O', error);
    return { capabilityRefreshFailed: true, output };
  }
};
