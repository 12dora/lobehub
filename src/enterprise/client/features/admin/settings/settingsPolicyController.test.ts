// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import enUS from '../../../../../../locales/en-US/admin.json';
import zhCN from '../../../../../../locales/zh-CN/admin.json';
import defaultAdmin from '../../../../../../packages/locales/src/default/admin';
import {
  buildChangePreview,
  deriveSettingsPermissions,
  fromSettingsPolicyUiMode,
  isServiceModelManaged,
  normalizeSettingsPolicyDraft,
  projectPolicyEditorOwnedDraft,
  SETTINGS_POLICY_GROUPS,
  SETTINGS_POLICY_UI_MODE_HINT_KEYS,
  SETTINGS_POLICY_UI_MODE_LABEL_KEYS,
  SETTINGS_POLICY_UI_MODES,
  settingsPolicyUiModeUsesValue,
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
    // The approval policy must stay editable here — it is the page's headline tool setting.
    expect(SETTINGS_POLICY_GROUPS).toContain('tool');
    expect(
      isServiceModelManaged({ group: 'tool', path: 'tool.humanIntervention.approvalMode' }),
    ).toBe(false);
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

  it('maps every stored mode onto its own UI tier (three-way, no collapsing)', () => {
    expect(SETTINGS_POLICY_UI_MODES).toEqual(['user', 'default', 'locked']);
    expect(toSettingsPolicyUiMode({ mode: 'user', visibility: 'hidden' })).toBe('user');
    expect(toSettingsPolicyUiMode({ mode: 'default', visibility: 'visible' })).toBe('default');
    expect(toSettingsPolicyUiMode({ mode: 'default', visibility: 'hidden' })).toBe('default');
    expect(toSettingsPolicyUiMode({ mode: 'locked', visibility: 'visible' })).toBe('locked');
    // Unknown/forward-compatible modes fail closed to the strictest tier.
    expect(toSettingsPolicyUiMode({ mode: 'future', visibility: 'visible' })).toBe('locked');

    expect(fromSettingsPolicyUiMode('user')).toEqual({ mode: 'user', visibility: 'visible' });
    expect(fromSettingsPolicyUiMode('default')).toEqual({
      mode: 'default',
      visibility: 'visible',
    });
    expect(fromSettingsPolicyUiMode('locked')).toEqual({ mode: 'locked', visibility: 'hidden' });

    // Only the two publishing tiers carry a platform value.
    expect(settingsPolicyUiModeUsesValue('user')).toBe(false);
    expect(settingsPolicyUiModeUsesValue('default')).toBe(true);
    expect(settingsPolicyUiModeUsesValue('locked')).toBe(true);
  });

  it('normalize preserves `default` and only canonicalizes visibility', () => {
    const normalized = normalizeSettingsPolicyDraft({
      a: { mode: 'default', schemaVersion: 1, value: 14, visibility: 'visible' },
      b: { mode: 'locked', schemaVersion: 1, value: true, visibility: 'visible' },
      c: { mode: 'user', schemaVersion: 1, value: 'x', visibility: 'hidden' },
      d: { mode: 'default', schemaVersion: 1, value: 'auto-run', visibility: 'hidden' },
    });
    // A published platform default must never be silently upgraded into a lock.
    expect(normalized.a).toMatchObject({ mode: 'default', visibility: 'visible', value: 14 });
    expect(normalized.b).toMatchObject({ mode: 'locked', visibility: 'hidden', value: true });
    expect(normalized.c).toMatchObject({ mode: 'user', visibility: 'visible', value: 'x' });
    expect(normalized.d).toMatchObject({
      mode: 'default',
      value: 'auto-run',
      visibility: 'visible',
    });
  });

  it('ships a translated label + hint for every tier (en-US and zh-CN)', () => {
    const bundles: Record<string, Record<string, string>> = {
      'default': defaultAdmin as Record<string, string>,
      'en-US': enUS as Record<string, string>,
      'zh-CN': zhCN as Record<string, string>,
    };
    for (const mode of SETTINGS_POLICY_UI_MODES) {
      const labelKey = SETTINGS_POLICY_UI_MODE_LABEL_KEYS[mode];
      const hintKey = SETTINGS_POLICY_UI_MODE_HINT_KEYS[mode];
      expect(labelKey).toMatch(/^settingsPolicy\.uiMode\./);
      expect(hintKey).toMatch(/^settingsPolicy\.uiMode\.hint\./);
      for (const [name, bundle] of Object.entries(bundles)) {
        expect(bundle[labelKey], `${name} is missing ${labelKey}`).toBeTruthy();
        expect(bundle[hintKey], `${name} is missing ${hintKey}`).toBeTruthy();
      }
    }
    const zh = bundles['zh-CN']!;
    expect(zh['settingsPolicy.uiMode.user']).toBe('用户自定义');
    expect(zh['settingsPolicy.uiMode.default']).toBe('平台默认值');
    expect(zh['settingsPolicy.uiMode.platform']).toBe('平台托管');
    // The approval setting is the reason the third tier exists — keep its copy aligned.
    expect(zh['settingsPolicy.paths.tool.humanIntervention.approvalMode.title']).toBe('批准策略');
    expect(zh['settingsPolicy.options.approval.autoRun']).toBe('自动批准');
    expect(zh['settingsPolicy.options.approval.allowList']).toBe('白名单');
    expect(zh['settingsPolicy.options.approval.manual']).toBe('手动批准');
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
        mode: 'locked' as const,
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
