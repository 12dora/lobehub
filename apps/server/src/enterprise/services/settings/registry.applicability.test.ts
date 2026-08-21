// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { settingsRegistry } from './registry';

describe('settingsRegistry applicability (B6-R2)', () => {
  it('rejects pure UI path when surface is server', () => {
    const code = settingsRegistry.assertPathWritable({
      client: 'server',
      path: 'general.animationMode',
    });
    expect(code).toBe('MANAGED_SETTING_INAPPLICABLE_CLIENT');
  });

  it('allows pure UI path for web client', () => {
    expect(
      settingsRegistry.assertPathWritable({ client: 'web', path: 'general.animationMode' }),
    ).toBeNull();
  });

  it('allows memory path for server runtime', () => {
    expect(
      settingsRegistry.assertPathWritable({ client: 'server', path: 'memory.enabled' }),
    ).toBeNull();
  });

  it('exposes the approval policy to the settings policy editor under the tool group', () => {
    const path = 'tool.humanIntervention.approvalMode';
    const entry = settingsRegistry.list().find((e) => e.path === path);

    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      control: 'select',
      group: 'tool',
      platformPolicyEligible: true,
      titleKey: 'settingsPolicy.paths.tool.humanIntervention.approvalMode.title',
    });
    // Every value the chat control can show must have an admin-side label.
    expect(entry?.options?.map((option) => option.value)).toEqual([
      'auto-run',
      'allow-list',
      'manual',
      'headless',
    ]);
    expect(settingsRegistry.assertPathWritable({ path, requirePlatformEligible: true })).toBeNull();
    // The tier the product asks for: platform default = auto approve.
    expect(settingsRegistry.validateValue(path, 'auto-run')).toMatchObject({ ok: true });
  });
});
