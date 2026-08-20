// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import {
  buildChangePreview,
  deriveSettingsPermissions,
  fromSettingsPolicyUiMode,
  isServiceModelManaged,
  normalizeSettingsPolicyDraft,
  projectPolicyEditorOwnedDraft,
  SETTINGS_POLICY_GROUPS,
  toSettingsPolicyUiMode,
} from './settingsPolicyController';

describe('settingsPolicyController', () => {
  it('hides service-model managed groups/paths from the settings policy surface', () => {
    expect(isServiceModelManaged({ group: 'image', path: 'image.any' })).toBe(true);
    expect(isServiceModelManaged({ group: 'systemAgent', path: 'systemAgent.x' })).toBe(true);
    expect(
      isServiceModelManaged({ group: 'defaultAgent', path: 'defaultAgent.config.model' }),
    ).toBe(true);
    expect(
      isServiceModelManaged({
        group: 'defaultAgent',
        path: 'defaultAgent.config.chatConfig.gpt5_6ReasoningEffort',
      }),
    ).toBe(true);
    expect(
      isServiceModelManaged({
        group: 'defaultAgent',
        path: 'defaultAgent.config.chatConfig.thinking',
      }),
    ).toBe(true);
    expect(
      isServiceModelManaged({
        group: 'defaultAgent',
        path: 'defaultAgent.config.chatConfig.enableStreaming',
      }),
    ).toBe(false);
    expect(isServiceModelManaged({ group: 'general', path: 'general.fontSize' })).toBe(false);
    expect(SETTINGS_POLICY_GROUPS).not.toContain('image');
    expect(SETTINGS_POLICY_GROUPS).toContain('general');
  });

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

  it('maps legacy mode/visibility into the two-state UI and normalizes on save', () => {
    expect(toSettingsPolicyUiMode({ mode: 'user', visibility: 'hidden' })).toBe('user');
    expect(toSettingsPolicyUiMode({ mode: 'default', visibility: 'visible' })).toBe('platform');
    expect(toSettingsPolicyUiMode({ mode: 'locked', visibility: 'visible' })).toBe('platform');
    expect(fromSettingsPolicyUiMode('user')).toEqual({ mode: 'user', visibility: 'visible' });
    expect(fromSettingsPolicyUiMode('platform')).toEqual({ mode: 'locked', visibility: 'hidden' });

    const normalized = normalizeSettingsPolicyDraft({
      a: { mode: 'default', schemaVersion: 1, value: 14, visibility: 'visible' },
      b: { mode: 'locked', schemaVersion: 1, value: true, visibility: 'visible' },
      c: { mode: 'user', schemaVersion: 1, value: 'x', visibility: 'hidden' },
    });
    expect(normalized.a).toMatchObject({ mode: 'locked', visibility: 'hidden', value: 14 });
    expect(normalized.b).toMatchObject({ mode: 'locked', visibility: 'hidden', value: true });
    expect(normalized.c).toMatchObject({ mode: 'user', visibility: 'visible', value: 'x' });
  });

  it('preserves foreign service-model rows byte-identical during normalize / project', () => {
    const foreign = {
      mode: 'default' as const,
      schemaVersion: 1,
      value: 'gpt-4o',
      visibility: 'visible' as const,
    };
    const draft = {
      'defaultAgent.config.model': foreign,
      'general.fontSize': {
        mode: 'default' as const,
        schemaVersion: 1,
        value: 16,
        visibility: 'visible' as const,
      },
    };
    const isForeign = (path: string) => path === 'defaultAgent.config.model';
    const normalized = normalizeSettingsPolicyDraft(draft, { preservePath: isForeign });
    expect(normalized['defaultAgent.config.model']).toBe(foreign);
    expect(normalized['general.fontSize']).toMatchObject({
      mode: 'locked',
      visibility: 'hidden',
      value: 16,
    });

    const owned = projectPolicyEditorOwnedDraft(draft, isForeign);
    expect(owned).not.toHaveProperty(['defaultAgent.config.model']);
    expect(owned['general.fontSize']).toMatchObject({ mode: 'locked', visibility: 'hidden' });
  });
});
