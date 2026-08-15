/**
 * Settings-service error classes.
 *
 * Own module so both `adminSettingsService.ts` and the extracted `applySettingsPatch.ts`
 * can throw them without an import cycle. Re-exported from `adminSettingsService.ts`.
 */

import type { SettingsValidationIssue } from '@/types/platform/settings';

export class SettingsDraftValidationError extends Error {
  readonly issues: SettingsValidationIssue[];
  constructor(issues: SettingsValidationIssue[]) {
    super('PLATFORM_CONFIG_VALIDATION_FAILED');
    this.name = 'SettingsDraftValidationError';
    this.issues = issues;
  }
}

/**
 * Draft has unpublished diffs on paths outside the applyImmediate patch.
 * Callers should direct admins to the Settings Policy page.
 */
export class SettingsDirtyDraftError extends Error {
  readonly dirtyPaths: string[];
  constructor(dirtyPaths: string[]) {
    super(
      'Unpublished settings draft differs outside the applied patch. Resolve on the Settings Policy page first.',
    );
    this.name = 'SettingsDirtyDraftError';
    this.dirtyPaths = dirtyPaths;
  }
}
