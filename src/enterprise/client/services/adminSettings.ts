import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminSettingsApplyImmediateInput,
  AdminSettingsApplyImmediateOutput,
  AdminSettingsGetDraftOutput,
  AdminSettingsSaveInput,
  AdminSettingsSaveOutput,
} from '@/server/enterprise/contracts/adminSettings';

/**
 * Typed client wrappers for `admin.settings.*`.
 * Components must not call lambdaClient directly — use this service + SWR hooks.
 */
class AdminSettingsService {
  /** Current editable policy set (draft is kept aligned with published by `save`). */
  getDraft = async (): Promise<AdminSettingsGetDraftOutput> => {
    return lambdaClient.admin.settings.getDraft.query();
  };

  /**
   * Apply policy-editor-owned settings site-wide in one transaction (no draft step).
   * Dangerous mutation: wrap the call in `withAdminReauthRetry`.
   */
  save = async (input: AdminSettingsSaveInput): Promise<AdminSettingsSaveOutput> => {
    return lambdaClient.admin.settings.save.mutate(input);
  };

  /**
   * Merge path values into the platform settings and publish immediately (W10-C).
   * Rate-limit: shared admin mutation limiter (60/min/actor/procedure).
   */
  applyImmediate = async (
    input: AdminSettingsApplyImmediateInput,
  ): Promise<AdminSettingsApplyImmediateOutput> => {
    return lambdaClient.admin.settings.applyImmediate.mutate(input);
  };
}

export const adminSettingsService = new AdminSettingsService();
