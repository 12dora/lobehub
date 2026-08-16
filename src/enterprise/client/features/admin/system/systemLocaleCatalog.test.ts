import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  adminSystemInstanceRevisionSchema,
  adminSystemJobKindSchema,
} from '../../../../../../apps/server/src/enterprise/contracts/adminSystem';

const loadAdminLocale = (locale: 'en-US' | 'zh-CN'): Record<string, string> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(here, '../../../../../../locales', locale, 'admin.json');
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
};

const instanceKinds = adminSystemInstanceRevisionSchema.shape.instanceKind.options;

describe('admin system value locale catalog (server-emitted)', () => {
  it('uses the server contracts as the sole coverage source (finite, non-empty)', () => {
    expect(adminSystemJobKindSchema.options.length).toBeGreaterThan(1);
    expect(instanceKinds.length).toBeGreaterThan(1);
  });

  it('has en-US and zh-CN labels for every job kind and instance kind', () => {
    const en = loadAdminLocale('en-US');
    const zh = loadAdminLocale('zh-CN');

    const missing: string[] = [];
    for (const kind of adminSystemJobKindSchema.options) {
      const key = `system.values.jobKind.${kind}`;
      if (!en[key]?.trim()) missing.push(`en:${key}`);
      if (!zh[key]?.trim()) missing.push(`zh:${key}`);
    }
    for (const kind of instanceKinds) {
      const key = `system.values.instanceKind.${kind}`;
      if (!en[key]?.trim()) missing.push(`en:${key}`);
      if (!zh[key]?.trim()) missing.push(`zh:${key}`);
    }

    expect(missing, `missing system value labels:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps the instance section copy in sync across both shipped locales', () => {
    const en = loadAdminLocale('en-US');
    const zh = loadAdminLocale('zh-CN');
    const keys = [
      'system.instances.columns.startedAt',
      'system.instances.counts',
      'system.instances.empty',
      'system.instances.emptyAll',
      'system.instances.filter.showOffline',
      'system.instances.fresh',
      'system.instances.stale',
      'system.instances.title',
    ];

    for (const key of keys) {
      expect(en[key]?.trim(), `missing en:${key}`).toBeTruthy();
      expect(zh[key]?.trim(), `missing zh:${key}`).toBeTruthy();
    }
    for (const locale of [en, zh]) {
      expect(locale['system.instances.counts']).toContain('{{live}}');
      expect(locale['system.instances.counts']).toContain('{{offline}}');
    }
    // Dead keys removed with the ledger rename — they must not come back.
    for (const locale of [en, zh]) {
      expect(locale['system.instances.columns.domains']).toBeUndefined();
      expect(locale['system.instances.lagging']).toBeUndefined();
    }
  });
});
