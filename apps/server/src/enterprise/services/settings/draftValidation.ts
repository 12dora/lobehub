/**
 * Settings draft validation + draft/published diffing.
 *
 * Extracted from `adminSettingsService.ts` so that file stays reviewable; the rules
 * themselves are unchanged and shared by every write path (`save`, `applyImmediate`,
 * and the internal publish pointer).
 */

import type { PlatformSettingsModel, SettingsDraftPolicyMap } from '@/database/models/platform';
import type { SettingsValidationIssue } from '@/types/platform/settings';

import { settingsRegistry } from './registry';

export interface SettingsDraftValidationResult {
  impactEstimate: { pathsWithOverrides: number; totalOverrideRows: number };
  issues: SettingsValidationIssue[];
  ok: boolean;
}

/**
 * Validate an entire draft bundle. Fail-closed on unknown / secret / wrong-type paths.
 * `model` is passed in so the caller can validate inside its own transaction.
 */
export const validateSettingsDraft = async (
  draft: SettingsDraftPolicyMap,
  model: PlatformSettingsModel,
): Promise<SettingsDraftValidationResult> => {
  const issues: SettingsValidationIssue[] = [];

  for (const [path, policy] of Object.entries(draft)) {
    const gate = settingsRegistry.assertPathWritable({
      path,
      requirePlatformEligible: true,
    });
    if (gate) {
      issues.push({ code: gate, message: gate, path });
      continue;
    }

    if (!['user', 'default', 'locked'].includes(policy.mode)) {
      issues.push({
        code: 'MANAGED_SETTING_INVALID_VALUE',
        message: `Invalid mode: ${String(policy.mode)}`,
        path,
      });
    }
    if (!['visible', 'hidden'].includes(policy.visibility)) {
      issues.push({
        code: 'MANAGED_SETTING_INVALID_VALUE',
        message: `Invalid visibility: ${String(policy.visibility)}`,
        path,
      });
    }

    // mode=user may omit a meaningful platform value; default/locked require a valid value.
    if (policy.mode === 'default' || policy.mode === 'locked') {
      const validated = settingsRegistry.validateValue(path, policy.value);
      if (!validated.ok) {
        issues.push({
          code: 'MANAGED_SETTING_INVALID_VALUE',
          message: validated.message,
          path,
        });
      }
    } else if (policy.value !== null && policy.value !== undefined) {
      const validated = settingsRegistry.validateValue(path, policy.value);
      if (!validated.ok) {
        issues.push({
          code: 'MANAGED_SETTING_INVALID_VALUE',
          message: validated.message,
          path,
        });
      }
    }

    const entry = settingsRegistry.get(path);
    if (entry && policy.schemaVersion !== entry.schemaVersion) {
      issues.push({
        code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
        message: `Schema version mismatch: expected ${entry.schemaVersion}, got ${policy.schemaVersion}`,
        path,
      });
    }
  }

  const impactPaths = Object.entries(draft)
    .filter(([, p]) => p.mode === 'locked' || p.mode === 'default')
    .map(([path]) => path);
  const impactEstimate = await model.countOverridesByPaths(impactPaths);

  return { impactEstimate, issues, ok: issues.length === 0 };
};

const policyFingerprint = (policy: {
  mode: string;
  schemaVersion: number;
  value?: unknown;
  visibility: string;
}): string =>
  JSON.stringify({
    mode: policy.mode,
    schemaVersion: policy.schemaVersion,
    value: policy.value,
    visibility: policy.visibility,
  });

/**
 * Paths where the draft diverges from published, ignoring `exemptPaths`.
 * Used by the applyImmediate dirty-draft gate.
 */
export const collectDirtyDraftPaths = (params: {
  draft: SettingsDraftPolicyMap;
  exemptPaths: Iterable<string>;
  published: SettingsDraftPolicyMap;
}): string[] => {
  const exempt = new Set(params.exemptPaths);
  const dirty: string[] = [];
  for (const path of new Set([...Object.keys(params.draft), ...Object.keys(params.published)])) {
    if (exempt.has(path)) continue;
    const d = params.draft[path];
    const p = params.published[path];
    if (!d && !p) continue;
    if (!d || !p || policyFingerprint(d) !== policyFingerprint(p)) dirty.push(path);
  }
  return dirty.sort();
};
