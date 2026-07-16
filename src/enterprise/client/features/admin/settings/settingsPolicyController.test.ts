// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import {
  buildChangePreview,
  deriveSettingsPermissions,
  fingerprintDraft,
  resolvePrimaryAction,
} from './settingsPolicyController';

describe('settingsPolicyController', () => {
  it('permission matrix: read-only / update / publish', () => {
    const auditor = deriveSettingsPermissions([PLATFORM_PERMISSIONS.SETTINGS_READ]);
    expect(auditor).toEqual({ canPublish: false, canUpdate: false, canView: true });

    const updater = deriveSettingsPermissions([
      PLATFORM_PERMISSIONS.SETTINGS_READ,
      PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
    ]);
    expect(updater.canUpdate).toBe(true);
    expect(updater.canPublish).toBe(false);

    const publisher = deriveSettingsPermissions([
      PLATFORM_PERMISSIONS.SETTINGS_READ,
      PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
      PLATFORM_PERMISSIONS.SETTINGS_PUBLISH,
    ]);
    expect(publisher.canPublish).toBe(true);
  });

  it('primary action: dirty → save; failed → retry; clean validated → publish', () => {
    const fp = fingerprintDraft({
      'general.fontSize': {
        mode: 'default',
        schemaVersion: 1,
        value: 18,
        visibility: 'visible',
      },
    });

    expect(
      resolvePrimaryAction({
        canPublish: true,
        canUpdate: true,
        dirty: true,
        draftFingerprint: fp,
        revisionConflict: false,
        saveState: 'idle',
        validatedForFingerprint: null,
      }),
    ).toBe('save');

    expect(
      resolvePrimaryAction({
        canPublish: true,
        canUpdate: true,
        dirty: true,
        draftFingerprint: fp,
        revisionConflict: false,
        saveState: 'failed',
        validatedForFingerprint: null,
      }),
    ).toBe('retry');

    expect(
      resolvePrimaryAction({
        canPublish: true,
        canUpdate: true,
        dirty: false,
        draftFingerprint: fp,
        revisionConflict: false,
        saveState: 'idle',
        validatedForFingerprint: fp,
      }),
    ).toBe('publish');

    expect(
      resolvePrimaryAction({
        canPublish: false,
        canUpdate: false,
        dirty: false,
        draftFingerprint: fp,
        revisionConflict: false,
        saveState: 'idle',
        validatedForFingerprint: fp,
      }),
    ).toBe('none');
  });

  it('change preview detects mode/value/visibility diffs', () => {
    const rows = buildChangePreview({
      draft: {
        'general.fontSize': {
          mode: 'locked',
          schemaVersion: 1,
          value: 20,
          visibility: 'hidden',
        },
      },
      published: {
        'general.fontSize': {
          mode: 'default',
          schemaVersion: 1,
          value: 18,
          visibility: 'visible',
        },
      },
      registryPaths: ['general.fontSize'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.changed).toBe(true);
    expect(rows[0]?.beforeMode).toBe('default');
    expect(rows[0]?.afterMode).toBe('locked');
  });

  it('edit invalidates validation fingerprint match', () => {
    const a = fingerprintDraft({
      a: { mode: 'user', schemaVersion: 1, value: 1, visibility: 'visible' },
    });
    const b = fingerprintDraft({
      a: { mode: 'user', schemaVersion: 1, value: 2, visibility: 'visible' },
    });
    expect(a).not.toBe(b);
  });
});
