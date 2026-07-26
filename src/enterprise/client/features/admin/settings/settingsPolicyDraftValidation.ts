import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

type DraftMap = AdminSettingsGetDraftOutput['draft'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Recovery storage is untrusted input. Validate the policy envelope before any
 * caller treats a parsed value as a DraftMap; the policy value itself remains
 * intentionally open because settings have heterogeneous schemas.
 */
export const isSettingsPolicyDraftMap = (value: unknown): value is DraftMap => {
  if (!isRecord(value)) return false;

  return Object.values(value).every(
    (policy) =>
      isRecord(policy) &&
      (policy.mode === 'user' || policy.mode === 'default' || policy.mode === 'locked') &&
      typeof policy.schemaVersion === 'number' &&
      Number.isInteger(policy.schemaVersion) &&
      (policy.visibility === 'visible' || policy.visibility === 'hidden'),
  );
};
