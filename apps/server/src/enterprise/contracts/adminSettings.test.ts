import { describe, expect, it } from 'vitest';

import {
  adminSettingsPublishInputSchema,
  adminSettingsRollbackInputSchema,
  adminSettingsSaveDraftInputSchema,
} from './adminSettings';

const draftToken = 'a'.repeat(64);
const safeReason = '  review global settings change  ';
const secretReason = 'Authorization: Bearer test-only-settings-credential';

describe('admin settings reason contract', () => {
  it('trims the shared bounded reason for save, publish and rollback', () => {
    expect(
      adminSettingsSaveDraftInputSchema.parse({
        draft: {},
        expectedDraftToken: draftToken,
        reason: safeReason,
      }).reason,
    ).toBe('review global settings change');
    expect(
      adminSettingsPublishInputSchema.parse({
        expectedDraftToken: draftToken,
        expectedRevision: 0,
        reason: safeReason,
      }).reason,
    ).toBe('review global settings change');
    expect(
      adminSettingsRollbackInputSchema.parse({
        expectedDraftToken: draftToken,
        expectedRevision: 1,
        reason: safeReason,
        targetRevision: 1,
      }).reason,
    ).toBe('review global settings change');
  });

  it('rejects secret material for save, publish and rollback reasons', () => {
    for (const result of [
      adminSettingsSaveDraftInputSchema.safeParse({
        draft: {},
        expectedDraftToken: draftToken,
        reason: secretReason,
      }),
      adminSettingsPublishInputSchema.safeParse({
        expectedDraftToken: draftToken,
        expectedRevision: 0,
        reason: secretReason,
      }),
      adminSettingsRollbackInputSchema.safeParse({
        expectedDraftToken: draftToken,
        expectedRevision: 1,
        reason: secretReason,
        targetRevision: 1,
      }),
    ]) {
      expect(result.success).toBe(false);
    }
  });

  it('rejects secret material in publication comments', () => {
    expect(
      adminSettingsPublishInputSchema.safeParse({
        comment: secretReason,
        expectedDraftToken: draftToken,
        expectedRevision: 0,
        reason: safeReason,
      }).success,
    ).toBe(false);
    expect(
      adminSettingsPublishInputSchema.safeParse({
        comment: 'Safe publish note for audit trail',
        expectedDraftToken: draftToken,
        expectedRevision: 0,
        reason: safeReason,
      }).success,
    ).toBe(true);
  });

  it('accepts empty publication comments and normalizes them to undefined', () => {
    expect(
      adminSettingsPublishInputSchema.parse({
        comment: '',
        expectedDraftToken: draftToken,
        expectedRevision: 0,
        reason: safeReason,
      }).comment,
    ).toBeUndefined();
    expect(
      adminSettingsPublishInputSchema.parse({
        comment: '   ',
        expectedDraftToken: draftToken,
        expectedRevision: 0,
        reason: safeReason,
      }).comment,
    ).toBeUndefined();
  });
});
