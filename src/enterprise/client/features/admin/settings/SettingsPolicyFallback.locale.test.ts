import { describe, expect, it } from 'vitest';

import enUS from '../../../../../../locales/en-US/admin.json';
import zhCN from '../../../../../../locales/zh-CN/admin.json';
import defaultAdmin from '../../../../../../packages/locales/src/default/admin';

describe('settings policy safe fallback locale coverage', () => {
  it('provides a human label in default, English, and Chinese locales', () => {
    expect(defaultAdmin['settingsPolicy.unknownSetting']).toBe('Setting {{index}}');
    expect(enUS['settingsPolicy.unknownSetting']).toBe('Setting {{index}}');
    expect(zhCN['settingsPolicy.unknownSetting']).toBe('设置 {{index}}');
  });
});
