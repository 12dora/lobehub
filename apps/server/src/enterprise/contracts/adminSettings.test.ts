import { describe, expect, it } from 'vitest';

import {
  adminSettingsApplyImmediateInputSchema,
  adminSettingsSaveInputSchema,
  adminSettingsSaveOutputSchema,
} from './adminSettings';

const draftToken = 'a'.repeat(64);
const safeReason = '  review global settings change  ';
const secretReason = 'Authorization: Bearer test-only-settings-credential';

const baseSave = {
  expectedDraftToken: draftToken,
  expectedRevision: 0,
  policies: {},
  reason: safeReason,
};

describe('admin settings save contract', () => {
  it('trims the shared bounded reason for save and applyImmediate', () => {
    expect(adminSettingsSaveInputSchema.parse(baseSave).reason).toBe(
      'review global settings change',
    );
    expect(
      adminSettingsApplyImmediateInputSchema.parse({
        patch: { 'general.fontSize': 16 },
        reason: safeReason,
      }).reason,
    ).toBe('review global settings change');
  });

  it('accepts removePaths-only applyImmediate and rejects an empty write', () => {
    expect(
      adminSettingsApplyImmediateInputSchema.parse({
        removePaths: ['defaultAgent.config.chatConfig.gpt5_6ReasoningEffort'],
      }).removePaths,
    ).toEqual(['defaultAgent.config.chatConfig.gpt5_6ReasoningEffort']);
    expect(adminSettingsApplyImmediateInputSchema.safeParse({}).success).toBe(false);
    expect(
      adminSettingsApplyImmediateInputSchema.safeParse({ patch: {}, removePaths: [] }).success,
    ).toBe(false);
  });

  it('rejects a path that appears in both patch and removePaths', () => {
    const path = 'defaultAgent.config.chatConfig.gpt5_6ReasoningEffort';
    const result = adminSettingsApplyImmediateInputSchema.safeParse({
      patch: { [path]: 'high' },
      removePaths: [path],
    });
    expect(result.success).toBe(false);
    expect(
      adminSettingsApplyImmediateInputSchema.safeParse({
        patch: { 'defaultAgent.config.model': 'gpt-5.6' },
        removePaths: [path],
      }).success,
    ).toBe(true);
  });

  it('rejects secret material in save reasons and comments', () => {
    expect(
      adminSettingsSaveInputSchema.safeParse({ ...baseSave, reason: secretReason }).success,
    ).toBe(false);
    expect(
      adminSettingsSaveInputSchema.safeParse({ ...baseSave, comment: secretReason }).success,
    ).toBe(false);
    expect(
      adminSettingsSaveInputSchema.safeParse({
        ...baseSave,
        comment: 'Safe publication note for the audit trail',
      }).success,
    ).toBe(true);
  });

  it('accepts empty comments and normalizes them to undefined', () => {
    expect(
      adminSettingsSaveInputSchema.parse({ ...baseSave, comment: '' }).comment,
    ).toBeUndefined();
    expect(
      adminSettingsSaveInputSchema.parse({ ...baseSave, comment: '   ' }).comment,
    ).toBeUndefined();
  });

  it('requires the full CAS base and rejects unknown keys', () => {
    // Empty policies is legal — it means "restore defaults for owned paths".
    expect(adminSettingsSaveInputSchema.parse(baseSave).policies).toEqual({});
    expect(() => adminSettingsSaveInputSchema.parse({ ...baseSave, extra: true })).toThrow();
    expect(() =>
      adminSettingsSaveInputSchema.parse({ ...baseSave, expectedDraftToken: 'short' }),
    ).toThrow();
    const { expectedRevision: _drop, ...missingRevision } = baseSave;
    expect(() => adminSettingsSaveInputSchema.parse(missingRevision)).toThrow();
    expect(() =>
      adminSettingsSaveInputSchema.parse({
        ...baseSave,
        policies: { 'general.fontSize': { mode: 'nope', schemaVersion: 1, visibility: 'visible' } },
      }),
    ).toThrow();
  });

  it('returns the fresh CAS base plus optional warnings', () => {
    expect(
      adminSettingsSaveOutputSchema.parse({
        auditId: 'audit-1',
        draftToken,
        revision: 3,
        warnings: ['ignored_service_model_paths:2'],
      }),
    ).toMatchObject({ revision: 3, warnings: ['ignored_service_model_paths:2'] });
    expect(
      adminSettingsSaveOutputSchema.parse({ auditId: 'audit-1', draftToken, revision: 1 }).warnings,
    ).toBeUndefined();
  });
});
