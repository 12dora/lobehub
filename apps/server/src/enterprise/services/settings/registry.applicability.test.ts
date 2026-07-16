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
});
